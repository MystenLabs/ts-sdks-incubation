// `register()` — One-shot on-chain bootstrap action factory.
//
// Distinct from `Publish` (which compiles + publishes Move bytecode):
// `Register` is for arbitrary on-chain transactions like registering a
// seal `KeyServer` object, walrus's deploy script, or similar bootstraps.
// Plugin authors typically also override `getStatus` for richer "is my
// registered thing still live on-chain?" checks (Q14 §10.1 fix).

import type { ActionRunContext, Provides, RegisterAction } from '../core/types.js';

export interface RegisterOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function register<TInputs extends Record<string, unknown>>(
	opts: RegisterOptions<TInputs>,
): RegisterAction<TInputs> {
	return {
		name: opts.name,
		type: 'Register',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		run: opts.run,
		getStatus: opts.getStatus,
	};
}
