// Dashboard plugin — CORS / origin allowlist policy.
//
// This MIRRORS the wallet's `plugins/wallet/origin-policy.ts` pattern
// (stack-scoped allowlist, `resolveOriginPolicy` / `checkOrigin`) rather
// than importing it, to avoid coupling dashboard→wallet. The two policies
// are intentionally small and self-contained; the wallet copy carries
// bearer-specific history that does not apply here.
//
// The allowed set is built from real, substrate-wired sources:
//
//   - the dashboard's OWN router-fronted origin for THIS stack
//     (`routedDashboardOrigin`) — the SPA is served same-origin from this
//     hostname, so the browser's `Origin` on `/graphql` IS this value;
//   - the direct loopback origin(s) the bundled SPA might be loaded from
//     when reached on the raw broker port (`directOrigins`);
//   - any explicit caller-supplied origins (`extraOrigins` →
//     `DashboardOptions.allowedOrigins`).
//
// We deliberately do NOT auto-allow a bare `*.localhost` / `localhost:<port>`
// form: `localhost` is not stack-scoped, so a sibling stack on the same
// port could drive the destructive control-plane mutations cross-origin.

import { Effect } from 'effect';

import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';

/** Result of resolving the origin allowlist at boot. Captured into the
 *  server closure so per-request checks are pure string comparison. */
export interface OriginPolicy {
	readonly allowed: ReadonlySet<string>;
}

/** Per-stack inputs the policy resolver needs. Supplied by the plugin at
 *  start time (identity + routed-url derivation); this module does not
 *  reach into the broker or router itself. */
export interface OriginPolicyInputs {
	readonly app: string;
	readonly stack: string;
	/** The dashboard's router-fronted origin for this stack
	 *  (`http://api.<app>.<stack>.localhost:<entrypoint-port>`). `null`
	 *  only in tests that bypass the router derivation. */
	readonly routedDashboardOrigin: string | null;
	/** Direct loopback origins the SPA may be loaded from when reached on
	 *  the raw broker port (host-loopback fallback / direct tooling). */
	readonly directOrigins: ReadonlyArray<string>;
	/** Explicit caller-supplied origins (`DashboardOptions.allowedOrigins`). */
	readonly extraOrigins: ReadonlyArray<string>;
}

/**
 * Resolve the per-stack origin allowlist.
 *
 *  - Always allowlisted: the dashboard's router-fronted origin for this
 *    stack (`routedDashboardOrigin`), when the router derivation produced
 *    one — this is the same-origin the bundled SPA loads from.
 *  - Always allowlisted: the direct loopback origins + any explicit
 *    caller-supplied `extraOrigins`.
 *
 * Empty-allowlist policy: allowed. The dashboard boots normally; with an
 * empty allowlist the per-request gate refuses every cross-origin request
 * (every Origin lands in `forbidden`). A `logWarning` surfaces the
 * configuration for operator visibility.
 */
export const resolveOriginPolicy = (inputs: OriginPolicyInputs): Effect.Effect<OriginPolicy> =>
	Effect.gen(function* () {
		const allowed = new Set<string>();

		if (inputs.routedDashboardOrigin !== null) {
			allowed.add(inputs.routedDashboardOrigin);
		}
		for (const o of inputs.directOrigins) {
			allowed.add(o);
		}
		for (const o of inputs.extraOrigins) {
			allowed.add(o);
		}

		if (allowed.size === 0) {
			yield* Effect.logWarning('dashboard origin allowlist is empty').pipe(
				Effect.annotateLogs({
					[SpanAttr.app]: inputs.app,
					[SpanAttr.stack]: inputs.stack,
				}),
			);
		}

		return { allowed } satisfies OriginPolicy;
	});

/** Per-request origin gate. Returns `'missing'` for absent Origin,
 *  `'forbidden'` for an Origin not in the allowlist, `'ok'` for accepted.
 *
 *  `'missing'` is its OWN shape: a request with no Origin (server-side
 *  tooling, the route-readiness probe, curl) is NOT a cross-origin browser
 *  request, so CORS does not govern it — the caller emits a normal response
 *  with no `Access-Control-Allow-Origin` header. */
export type OriginCheckResult = 'missing' | 'forbidden' | 'ok';

export const checkOrigin = (
	policy: OriginPolicy,
	headerValue: string | null | undefined,
): OriginCheckResult => {
	if (headerValue === undefined || headerValue === null || headerValue.length === 0) {
		return 'missing';
	}
	return policy.allowed.has(headerValue) ? 'ok' : 'forbidden';
};
