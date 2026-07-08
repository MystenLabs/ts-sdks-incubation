// Wallet plugin — CORS / origin allowlist policy.
//
// The allowlist is built from two real, substrate-wired sources: the
// router-fronted dev-server origin for this stack (`routedAppOrigin`,
// generalized to same-stack routed endpoint origins) and any
// caller-supplied `extraOrigins`. Both are stack-scoped or explicit, so
// neither opens the cross-stack pairing risk described in 15-wallet.md.
//
// No raw-loopback origin: with the `hostService(...)` plugin devstack
// owns the dev server's bind port (the broker allocates it; Vite binds
// it via `--port {port}`), so the raw-loopback origin
// (`http://127.0.0.1:<port>` / `http://localhost:<port>`) the dev sees
// in Vite's own console banner is a real, knowable origin. The canonical
// fix lives on the host-service side: it publishes the ROUTED origin as
// its `HostServiceValue.url`, so `devstack up` output (and any consumer
// holding the resolved host-service value) point devs at the URL whose
// Origin THIS allowlist already accepts (the routed `routedAppOrigin`).
// A raw-loopback allowlist branch would have to thread the host-service's
// dynamic bind port into the wallet, which runs in the OPPOSITE direction
// of the dependency edge (host-service `dependsOn` wallet), so the wallet
// has no view of that port at its own boot. Devs who must load the raw
// Vite URL pass it via `allowedOrigins` (→ `extraOrigins`).
//
// Why "origin + bearer together": bearer alone leaves a non-browser-
// tooling bypass — curl / fetch from a service worker can forge
// `Authorization` from a leaked token. Browsers always send `Origin`;
// non-browsers omit it. Demanding BOTH closes the bypass.

import { Effect } from 'effect';

import { LogAttr } from '../../substrate/runtime/observability/log-attrs.ts';
import { DEFAULT_STACK } from '../../substrate/runtime/routed-url.ts';

// ----------------------------------------------------------------------
// Policy shape
// ----------------------------------------------------------------------

/** Result of resolving the origin allowlist at boot. Captured into
 *  the HTTP handler closure so per-request checks are pure-string
 *  comparison. */
export interface OriginPolicy {
	readonly allowed: ReadonlySet<string>;
	readonly routedAppOriginPattern: string | null;
	readonly routedAppOriginScope: RoutedAppOriginScope | null;
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

export interface RoutedAppOriginScope {
	readonly protocol: string;
	readonly port: string;
	readonly app: string;
	readonly stack: string;
	readonly pattern: string;
}

const routedAppOriginScope = (inputs: OriginPolicyInputs): RoutedAppOriginScope | null => {
	if (inputs.routedAppOrigin === null) return null;
	try {
		const url = new URL(inputs.routedAppOrigin);
		const app = inputs.app.toLowerCase();
		const stack = inputs.stack.toLowerCase();
		const suffix = stack === DEFAULT_STACK ? `${app}.localhost` : `${stack}.${app}.localhost`;
		return {
			protocol: url.protocol,
			port: url.port,
			app,
			stack,
			pattern: `${url.protocol}//*.${suffix}${url.port.length > 0 ? `:${url.port}` : ''}`,
		};
	} catch {
		return null;
	}
};

const isSameStackRoutedOrigin = (scope: RoutedAppOriginScope, origin: string): boolean => {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.origin !== origin) return false;
	if (url.protocol !== scope.protocol || url.port !== scope.port) return false;

	const labels = url.hostname.toLowerCase().split('.');
	if (scope.stack === DEFAULT_STACK) {
		return (
			labels.length === 3 &&
			labels[0]!.length > 0 &&
			labels[1] === scope.app &&
			labels[2] === 'localhost'
		);
	}
	return (
		labels.length === 4 &&
		labels[0]!.length > 0 &&
		labels[1] === scope.stack &&
		labels[2] === scope.app &&
		labels[3] === 'localhost'
	);
};

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
		const routedScope = routedAppOriginScope(inputs);

		if (inputs.routedAppOrigin !== null) {
			allowed.add(inputs.routedAppOrigin);
		}

		for (const o of inputs.extraOrigins) {
			allowed.add(o);
		}

		if (allowed.size === 0) {
			yield* Effect.logWarning('wallet origin allowlist is empty').pipe(
				Effect.annotateLogs({
					[LogAttr.app]: inputs.app,
					[LogAttr.stack]: inputs.stack,
				}),
			);
		}

		return {
			allowed,
			routedAppOriginPattern: routedScope?.pattern ?? null,
			routedAppOriginScope: routedScope,
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
	if (policy.allowed.has(headerValue)) return 'ok';
	if (
		policy.routedAppOriginScope !== null &&
		isSameStackRoutedOrigin(policy.routedAppOriginScope, headerValue)
	) {
		return 'ok';
	}
	return 'forbidden';
};

export const describeAllowedOrigins = (policy: OriginPolicy): ReadonlyArray<string> => [
	...policy.allowed,
	...(policy.routedAppOriginPattern === null ? [] : [policy.routedAppOriginPattern]),
];

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
