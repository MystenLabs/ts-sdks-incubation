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
	inputs: TInputs;
	check: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function verify<TInputs extends Record<string, unknown>>(
	opts: VerifyOptions<TInputs>,
): VerifyAction<TInputs> {
	return {
		name: opts.name,
		type: 'Verify',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		getStatus: opts.check,
	};
}
