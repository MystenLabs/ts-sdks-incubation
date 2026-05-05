// `buildImage()` — Build action factory.
//
// P1: returns a typed BuildAction. Real Docker integration lands in P4
// (sui plugin) when the first plugin needs to actually produce an image.

import type { ActionRunContext, BuildAction, Provides } from '../core/types.js';

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
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
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
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}
