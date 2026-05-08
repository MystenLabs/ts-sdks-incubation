// `emit()` — Sink action factory. Reads the registry; writes files.
//
// Re-runs when `dependsOnKind` intersects the registry's dirty set after a
// reconciliation cycle. `dependsOnKind` accepts core kind names
// (`'packages'`) or dotted namespaced kinds (`'walrus.blobs'`). The Emit's
// own input hash also affects skipping — if the emitter version or output
// config changes, it re-runs even when no kinds are dirty.

import type { ActionRunContext, EmitAction, Provides } from '../core/types.js';
import type { WithNeeds } from './with-needs.js';

export interface EmitOptions<
	TInputs extends Record<string, unknown>,
	TNeeds extends string,
> {
	name: string;
	/**
	 * Action references this emit depends on. Bare names resolve against
	 * sibling setup actions in the same synthetic `<app>-setup` plugin;
	 * dotted names reference plugin actions in the surrounding
	 * `defineDevstackConfig({ use: [...] })` array. Dotted references
	 * are validated at compile time against the union of every
	 * `Plugin<TProvides>` in `use:` — typos surface at the
	 * `defineDevstackConfig({ use: [...] })` call site.
	 */
	needs?: readonly TNeeds[];
	provides?: Provides;
	inputs: TInputs;
	dependsOnKind?: readonly string[];
	run: (ctx: ActionRunContext<string, TNeeds>) => Promise<void>;
	getStatus?: (
		ctx: ActionRunContext<string, TNeeds>,
	) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext<string, TNeeds>) => Promise<string | undefined>;
}

export function emit<
	TInputs extends Record<string, unknown>,
	const TNeeds extends string = never,
>(
	opts: EmitOptions<TInputs, TNeeds>,
): WithNeeds<TNeeds, EmitAction<TInputs>> {
	return {
		name: opts.name,
		type: 'Emit',
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		inputs: opts.inputs,
		dependsOnKind: opts.dependsOnKind as string[] | undefined,
		run: opts.run as (ctx: ActionRunContext) => Promise<void>,
		getStatus: opts.getStatus as
			| ((ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>)
			| undefined,
		identity: opts.identity as
			| ((ctx: ActionRunContext) => Promise<string | undefined>)
			| undefined,
	} as WithNeeds<TNeeds, EmitAction<TInputs>>;
}
