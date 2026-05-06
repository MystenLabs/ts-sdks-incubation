// `emit()` — Sink action factory. Reads the registry; writes files.
//
// Re-runs when `dependsOnKind` intersects the registry's dirty set after a
// reconciliation cycle. `dependsOnKind` accepts core kind names
// (`'packages'`) or namespaced (`'walrus/blobs'`). The Emit's own input
// hash also affects skipping — if the emitter version or output config
// changes, it re-runs even when no kinds are dirty.

import type { ActionRunContext, EmitAction, Provides } from '../core/types.js';
import { mergeRegistryShortcut } from '../core/types.js';

interface EmitOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Sugar for `provides: { registry }`. */
	registry?: (ctx: ActionRunContext) => Promise<void> | void;
	inputs: TInputs;
	dependsOnKind?: string[];
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
}

export function emit<TInputs extends Record<string, unknown>>(
	opts: EmitOptions<TInputs>,
): EmitAction<TInputs> {
	return {
		name: opts.name,
		type: 'Emit',
		needs: opts.needs,
		provides: mergeRegistryShortcut(opts.provides, opts.registry),
		inputs: opts.inputs,
		dependsOnKind: opts.dependsOnKind,
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}
