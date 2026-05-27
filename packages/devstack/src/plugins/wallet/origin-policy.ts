// Wallet plugin — CORS / origin allowlist policy.
//
// Distilled-doc problem (15-wallet.md "Cross-stack pairing risk"): the
// legacy wallet auto-allowlisted `http://localhost:<vite-port>` per
// stack. Two sibling stacks running vite on the same `localhost:5175`
// (or `5176`, etc.) could pair with EITHER wallet — CORS lets the
// request through, and the bearer token (once leaked once via any
// channel) is enough to sign.
//
// Architecture decision (per task):
//
//   - Stack-scoped allowlist. The vite-port-derived origin is added to
//     this stack's allowlist ONLY when the substrate's port broker
//     records THIS stack as the owner of that vite port.
//   - The stack-scoped host (e.g. `http://dev.<stack>.<app>.localhost:<port>`)
//     is the canonical browser entry — always allowlisted.
//   - The raw `http://localhost:<port>` form is OFF by default; opt-in
//     via `WalletOptions.allowLocalhostVite: true` for callers who
//     want the legacy behavior (e.g. headless test runners that pin
//     `localhost`). Documented as a security tradeoff in the factory's
//     JSDoc.
//
// Why "origin + bearer together" (task requirement #3): bearer alone
// leaves a non-browser-tooling bypass — curl / fetch from a service
// worker can forge `Authorization` from a leaked token. Browsers
// always send `Origin`; non-browsers omit it. Demanding BOTH closes
// the bypass.

import { Effect } from 'effect';

import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';
import { WalletSpans } from './spans.ts';

// ----------------------------------------------------------------------
// Policy shape
// ----------------------------------------------------------------------

/** Result of resolving the origin allowlist at boot. Captured into
 *  the HTTP handler closure so per-request checks are pure-string
 *  comparison. */
export interface OriginPolicy {
	readonly allowed: ReadonlySet<string>;
	/** True if the policy permitted the `http://localhost:<vite-port>`
	 *  form. Carried for renderer / log hygiene — surfaces in the
	 *  manifest as a flag so the TUI can warn. */
	readonly localhostViteEnabled: boolean;
	/** Bare host (e.g. `dev.<stack>.<app>.localhost`) the stack-scoped
	 *  origin resolves under. Captured for log lines. */
	readonly stackScopedHost: string;
}

/** Per-stack inputs the policy resolver needs. Supplied by the
 *  substrate at acquire time (port broker + identity); this module
 *  doesn't reach into the broker itself. */
export interface OriginPolicyInputs {
	readonly app: string;
	readonly stack: string;
	readonly vitePortForThisStack: number | null;
	readonly routedAppOrigin: string | null;
	readonly extraOrigins: ReadonlyArray<string>;
	readonly allowLocalhostVite: boolean;
}

// ----------------------------------------------------------------------
// Resolution
// ----------------------------------------------------------------------

/**
 * Resolve the per-stack origin allowlist.
 *
 *  - Always allowlisted: the stack-scoped router host
 *    `http://dev.<stack>.<app>.localhost:<vite-port>`, IF the broker recorded
 *    a vite port for this stack.
 *  - Conditionally allowlisted: the bare `http://localhost:<vite-port>`
 *    form. Off by default; on iff `allowLocalhostVite` is true.
 *  - Always allowlisted: any explicit caller-supplied origins from
 *    `extraOrigins`.
 *
 * Empty-allowlist policy (vite absent AND no `extraOrigins`): allowed.
 * The wallet boots normally; with an empty allowlist the per-request
 * gate refuses every request (every Origin lands in `forbidden`). This
 * is the correct behavior for a stack composed without any client UI
 * (e.g. node-only smoke / e2e configs) — the wallet's keypair + token
 * are still useful for the host process, but the HTTP surface is
 * effectively closed. A `Effect.logWarning` surfaces the configuration
 * for operator visibility.
 */
export const resolveOriginPolicy = (
	inputs: OriginPolicyInputs,
): Effect.Effect<OriginPolicy> =>
	Effect.gen(function* () {
		const allowed = new Set<string>();
		const stackScopedHost =
			inputs.stack === 'main'
				? `dev.${inputs.app}.localhost`
				: `dev.${inputs.stack}.${inputs.app}.localhost`;

		if (inputs.vitePortForThisStack !== null) {
			allowed.add(`http://${stackScopedHost}:${inputs.vitePortForThisStack}`);
			if (inputs.allowLocalhostVite) {
				allowed.add(`http://localhost:${inputs.vitePortForThisStack}`);
			}
		}

		if (inputs.routedAppOrigin !== null) {
			allowed.add(inputs.routedAppOrigin);
		}

		for (const o of inputs.extraOrigins) {
			allowed.add(o);
		}

		if (allowed.size === 0) {
			yield* Effect.logWarning('wallet origin allowlist is empty').pipe(
				Effect.annotateLogs({
					[SpanAttr.app]: inputs.app,
					[SpanAttr.stack]: inputs.stack,
					[WalletSpans.localhostViteEnabled]: inputs.allowLocalhostVite,
				}),
			);
		}

		return {
			allowed,
			localhostViteEnabled: inputs.allowLocalhostVite,
			stackScopedHost,
		} satisfies OriginPolicy;
	});

// ----------------------------------------------------------------------
// Per-request check
// ----------------------------------------------------------------------

/** Per-request origin gate. Returns `'missing'` for absent Origin,
 *  `'forbidden'` for Origin not in the allowlist, `'ok'` for accepted.
 *
 *  Distilled-doc invariant (C12): missing Origin is its OWN refusal
 *  shape (closes the curl / non-browser bypass — bearer alone is not
 *  enough). */
export type OriginCheckResult = 'missing' | 'forbidden' | 'ok';

export const checkOrigin = (
	policy: OriginPolicy,
	headerValue: string | undefined,
): OriginCheckResult => {
	if (headerValue === undefined || headerValue.length === 0) return 'missing';
	return policy.allowed.has(headerValue) ? 'ok' : 'forbidden';
};

/** Compose CORS headers for a successful request. Single-allowed-origin
 *  echo (browsers don't honor wildcard with credentials, and we want
 *  to keep `Access-Control-Allow-Credentials` open for fetch with
 *  `credentials: 'include'` if a future codegen seam needs it). */
export const corsHeadersFor = (origin: string): Readonly<Record<string, string>> => ({
	'access-control-allow-origin': origin,
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-credentials': 'true',
	vary: 'origin',
});
