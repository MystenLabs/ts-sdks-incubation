// `service()` — Service action factory (long-running container/process).
//
// Service actions are localnet-only by construction: the action filters
// in `cli/filters.ts` strip them on testnet/mainnet cycles. Reflect that
// in the type system — `run` / `getStatus` / `identity` callbacks here
// receive `LocalnetActionRunContext` directly so plugin code reads
// `ctx.stack`, `ctx.ports`, etc. without a `requireLocalnetCtx(ctx)`
// runtime assert. The factory casts the closures into the wider
// `ActionRunContext`-receiving shape that the reconciler needs because
// `ServiceAction.run` is part of the `Action` union.

import type { LocalnetActionRunContext, Provides, ServiceAction } from '../core/types.js';
import { mergeRegistryShortcut } from '../core/types.js';

interface ServiceOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Sugar for `provides: { registry }`. */
	registry?: (ctx: LocalnetActionRunContext) => Promise<void> | void;
	inputs: TInputs;
	run: (ctx: LocalnetActionRunContext) => Promise<void>;
	getStatus?: (ctx: LocalnetActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: LocalnetActionRunContext) => Promise<string | undefined>;
}

export function service<TInputs extends Record<string, unknown>>(
	opts: ServiceOptions<TInputs>,
): ServiceAction<TInputs> {
	return {
		name: opts.name,
		type: 'Service',
		needs: opts.needs,
		provides: mergeRegistryShortcut(opts.provides, opts.registry),
		inputs: opts.inputs,
		run: opts.run as ServiceAction<TInputs>['run'],
		getStatus: opts.getStatus as ServiceAction<TInputs>['getStatus'],
		identity: opts.identity as ServiceAction<TInputs>['identity'],
	};
}
