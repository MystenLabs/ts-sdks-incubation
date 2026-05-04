// `verify()` — read-only invariant action factory.
//
// Verify runs only its `getStatus`-shaped predicate; the reconciler fails
// the cycle on `ok: false`. No `run`. Wire downstream of whichever Service
// it gates so a misconfiguration surfaces as a loud failure rather than
// letting downstream actions encounter a silent bad state.

import type { ActionRunContext, Provides, VerifyAction } from '../core/types.js';

export interface VerifyOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Optional inputs payload. Verify actions don't use the input-hash
	 * skip predicate (they re-run every cycle by design), so inputs are
	 * mostly informational — useful for snapshot identification when an
	 * invariant probe needs to re-run on input drift. */
	inputs?: TInputs;
	check: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function verify<TInputs extends Record<string, unknown> = Record<string, unknown>>(
	opts: VerifyOptions<TInputs>,
): VerifyAction<TInputs> {
	return {
		name: opts.name,
		type: 'Verify',
		needs: opts.needs,
		provides: opts.provides,
		...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
		getStatus: opts.check,
	};
}
