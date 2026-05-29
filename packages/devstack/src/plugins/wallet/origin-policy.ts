// Wallet plugin — CORS / origin allowlist policy.
//
// The allowlist is built from two real, substrate-wired sources: the
// router-fronted dev-server origin for this stack (`routedAppOrigin`)
// and any caller-supplied `extraOrigins`. Both are stack-scoped or
// explicit, so neither opens the cross-stack pairing risk described in
// 15-wallet.md.
//
// History (removed): an earlier design auto-allowlisted a vite-port-
// derived origin (`http://dev.<stack>.<app>.localhost:<vite-port>`,
// plus an opt-in `http://localhost:<vite-port>`). That branch was dead:
// devstack never tracks an external vite dev server's port — there is
// no vite plugin and the port broker only allocates (and exposes) ports
// for in-stack plugins, with no reader/lookup API. `vitePortForThisStack`
// was always `null` at the only production call site, so the branch
// never fired. Per STYLE_GUIDE §5 ("code either works or doesn't exist")
// the whole vite-origin path — and the `allowLocalhostVite` opt-in it
// gated — was removed rather than left as an unreachable allowlist seam.
//
// Why "origin + bearer together": bearer alone leaves a non-browser-
// tooling bypass — curl / fetch from a service worker can forge
// `Authorization` from a leaked token. Browsers always send `Origin`;
// non-browsers omit it. Demanding BOTH closes the bypass.

import { Effect } from 'effect';

import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';

// ----------------------------------------------------------------------
// Policy shape
// ----------------------------------------------------------------------

/** Result of resolving the origin allowlist at boot. Captured into
 *  the HTTP handler closure so per-request checks are pure-string
 *  comparison. */
export interface OriginPolicy {
	readonly allowed: ReadonlySet<string>;
}

/** Per-stack inputs the policy resolver needs. Supplied by the
 *  substrate at acquire time (identity + routed-url derivation); this
 *  module doesn't reach into the broker itself. */
export interface OriginPolicyInputs {
	readonly app: string;
	readonly stack: string;
	readonly routedAppOrigin: string | null;
	readonly extraOrigins: ReadonlyArray<string>;
}

// ----------------------------------------------------------------------
// Resolution
// ----------------------------------------------------------------------

/**
 * Resolve the per-stack origin allowlist.
 *
 *  - Always allowlisted: the router-fronted dev-server origin for this
 *    stack (`routedAppOrigin`), when the router derivation produced one.
 *  - Always allowlisted: any explicit caller-supplied origins from
 *    `extraOrigins`.
 *
 * Empty-allowlist policy (no `routedAppOrigin` AND no `extraOrigins`):
 * allowed. The wallet boots normally; with an empty allowlist the
 * per-request gate refuses every request (every Origin lands in
 * `forbidden`). This is the correct behavior for a stack composed
 * without any client UI (e.g. node-only smoke / e2e configs) — the
 * wallet's keypair + token are still useful for the host process, but
 * the HTTP surface is effectively closed. A `Effect.logWarning`
 * surfaces the configuration for operator visibility.
 */
export const resolveOriginPolicy = (inputs: OriginPolicyInputs): Effect.Effect<OriginPolicy> =>
	Effect.gen(function* () {
		const allowed = new Set<string>();

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
				}),
			);
		}

		return { allowed } satisfies OriginPolicy;
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
