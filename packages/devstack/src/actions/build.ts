// `buildImage()` — Build action factory.
//
// Build actions are localnet-only by construction: the action filters
// in `cli/filters.ts` strip them on testnet/mainnet cycles. Reflect that
// in the type system — `run` / `getStatus` / `identity` callbacks here
// receive `LocalnetActionRunContext` directly so plugin code reads
// `ctx.stack`, `ctx.ports`, etc. without a `requireLocalnetCtx(ctx)`
// runtime assert. The factory casts the closures into the wider
// `ActionRunContext`-receiving shape that the reconciler needs because
// `BuildAction.run` is part of the `Action` union.

import type { BuildAction, LocalnetActionRunContext, Provides } from '../core/types.js';

interface BuildImageOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Extra paths the file watcher should treat as inputs to this
	 * action. Resolved against `appDir`; supports glob syntax. Useful
	 * for builds whose triggers aren't captured by `inputs` (e.g. local
	 * source trees behind an `imports({ local: { path } })`). */
	watches?: string[];
	inputs: TInputs;
	run: (ctx: LocalnetActionRunContext) => Promise<void>;
	getStatus?: (ctx: LocalnetActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: LocalnetActionRunContext) => Promise<string | undefined>;
}

export function buildImage<TInputs extends Record<string, unknown>>(
	opts: BuildImageOptions<TInputs>,
): BuildAction<TInputs> {
	return {
		name: opts.name,
		type: 'Build',
		needs: opts.needs,
		provides: opts.provides,
		watches: opts.watches,
		inputs: opts.inputs,
		run: opts.run as BuildAction<TInputs>['run'],
		getStatus: opts.getStatus as BuildAction<TInputs>['getStatus'],
		identity: opts.identity as BuildAction<TInputs>['identity'],
	};
}
