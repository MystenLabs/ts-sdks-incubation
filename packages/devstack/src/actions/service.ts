// `service()` — Service action factory (long-running container/process).
//
// Service actions are localnet-only by construction (the action filters
// in `cli/filters.ts` strip them on testnet/mainnet cycles), so
// `ServiceAction.run` / `getStatus` / `identity` receive
// `LocalnetActionRunContext` directly — `ctx.stack`, `ctx.ports`, etc.
// read without any runtime narrowing.

import type { LocalnetActionRunContext, Provides, ServiceAction } from '../core/types.js';

export interface ServiceOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides<LocalnetActionRunContext>;
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
		provides: opts.provides,
		inputs: opts.inputs,
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}
