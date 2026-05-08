// `verify()` — read-only invariant action factory.
//
// Verify runs only its `getStatus`-shaped predicate; the reconciler fails
// the cycle on `ok: false`. No `run`. Wire downstream of whichever Service
// it gates so a misconfiguration surfaces as a loud failure rather than
// letting downstream actions encounter a silent bad state.

import type { ActionRunContext, Provides, VerifyAction } from '../core/types.js';
import type { WithNeeds } from './with-needs.js';

export interface VerifyOptions<
	TInputs extends Record<string, unknown>,
	TNeeds extends string,
> {
	name: string;
	/**
	 * Action references this verify depends on. Bare names resolve
	 * against sibling setup actions in the same synthetic `<app>-setup`
	 * plugin; dotted names reference plugin actions in the surrounding
	 * `defineDevstackConfig({ use: [...] })` array. Dotted references
	 * are validated at compile time against the union of every
	 * `Plugin<TProvides>` in `use:`.
	 */
	needs?: readonly TNeeds[];
	provides?: Provides;
	/** Inputs payload. Verify actions don't use the input-hash skip
	 * predicate (they re-run every cycle by design), so the value is
	 * informational — surfaces in the manifest snapshot of action state
	 * for diagnostic purposes. Pass `{}` when the probe has no
	 * meaningful inputs. */
	inputs: TInputs;
	/** Read-only invariant check. Returns `{ok, detail?}`. Named to
	 * match `getStatus` on every other factory so authors don't have to
	 * remember a per-factory naming exception.
	 *
	 * `ctx.registry.packages.find/require` is typed against the union
	 * of bare-name `needs:` (typically the related `publishMove` action
	 * names). Verify actions don't sign by design (no `runsAs`), so
	 * `ctx.accounts` keeps its loose default — call sites that need a
	 * specific account name pass it through `inputs:` and reach for it
	 * with the standard `ctx.accounts.get(...)` cast. */
	getStatus: (
		ctx: ActionRunContext<string, TNeeds>,
	) => Promise<{ ok: boolean; detail?: string }>;
}

export function verify<
	TInputs extends Record<string, unknown>,
	const TNeeds extends string = never,
>(
	opts: VerifyOptions<TInputs, TNeeds>,
): WithNeeds<TNeeds, VerifyAction<TInputs>> {
	return {
		name: opts.name,
		type: 'Verify',
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		inputs: opts.inputs,
		getStatus: opts.getStatus as (
			ctx: ActionRunContext,
		) => Promise<{ ok: boolean; detail?: string }>,
	} as WithNeeds<TNeeds, VerifyAction<TInputs>>;
}
