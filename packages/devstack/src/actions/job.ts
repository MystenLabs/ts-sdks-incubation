// `job()` — Service action factory for run-once tasks: one-shot containers
// (walrus deploy script), network setup actions, anything where exit(0)
// means healthy and there's no daemon to keep alive.
//
// Same underlying `ServiceAction` shape as `service()`. The split exists so
// readers can see at a glance: this action runs once, has no live state to
// probe, and `getStatus` is typically "did the artifact this job produced
// already get persisted somewhere we can detect?"
//
// Pair with `provides: { registry: ... }` so the warm path repopulates any
// registry entries the job emitted on cold cycle.

import type { ActionRunContext, Provides, ServiceAction } from '../core/types.js';

export interface JobOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function job<TInputs extends Record<string, unknown>>(
	opts: JobOptions<TInputs>,
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
