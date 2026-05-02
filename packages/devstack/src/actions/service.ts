// `service()` — Service action factory (long-running container/process).
//
// P1: typed wrapper. Compose-fragment shape + lifecycle handling lands in
// P2 (supervisor) and P4 (sui plugin's actual compose render).

import type { ActionRunContext, Provides, ServiceAction } from '../core/types.js';

export interface ServiceOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
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
	};
}
