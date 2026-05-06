// `verify()` — read-only invariant action factory.
//
// Verify runs only its `getStatus`-shaped predicate; the reconciler fails
// the cycle on `ok: false`. No `run`. Wire downstream of whichever Service
// it gates so a misconfiguration surfaces as a loud failure rather than
// letting downstream actions encounter a silent bad state.

import type { ActionRunContext, Provides, VerifyAction } from '../core/types.js';
import { mergeRegistryShortcut } from '../core/types.js';

interface VerifyOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Sugar for `provides: { registry }`. */
	registry?: (ctx: ActionRunContext) => Promise<void> | void;
	/** Inputs payload. Verify actions don't use the input-hash skip
	 * predicate (they re-run every cycle by design), so the value is
	 * informational — surfaces in the manifest snapshot of action state
	 * for diagnostic purposes. Pass `{}` when the probe has no
	 * meaningful inputs. */
	inputs: TInputs;
	/** Read-only invariant check. Returns `{ok, detail?}`. Named to
	 * match `getStatus` on every other factory so authors don't have to
	 * remember a per-factory naming exception. */
	getStatus: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function verify<TInputs extends Record<string, unknown>>(
	opts: VerifyOptions<TInputs>,
): VerifyAction<TInputs> {
	return {
		name: opts.name,
		type: 'Verify',
		needs: opts.needs,
		provides: mergeRegistryShortcut(opts.provides, opts.registry),
		inputs: opts.inputs,
		getStatus: opts.getStatus,
	};
}
