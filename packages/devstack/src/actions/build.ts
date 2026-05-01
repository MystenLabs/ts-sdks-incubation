// `buildImage()` — Build action factory.
//
// P1: returns a typed BuildAction. Real Docker integration lands in P4
// (sui plugin) when the first plugin needs to actually produce an image.

import type { ActionRunContext, BuildAction } from '../core/types.js';

export interface BuildImageOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: string[];
	inputs: TInputs;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function buildImage<TInputs extends Record<string, unknown>>(
	opts: BuildImageOptions<TInputs>,
): BuildAction<TInputs> {
	return {
		name: opts.name,
		type: 'Build',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		run: opts.run,
		getStatus: opts.getStatus,
	};
}
