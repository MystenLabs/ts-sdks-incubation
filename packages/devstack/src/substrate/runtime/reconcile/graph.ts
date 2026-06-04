// Dep-graph ordering — `plan(graph, scope)`, the single dep-ordering body.
//
// Given a slice (carried on a `graph-keys` scope) it produces the
// teardown (reverse-dep) and acquire (forward-dep) orderings via the
// kept `orderByLevel` level-ordering helper. Full-graph drains call it
// directly with every key; the exclude-predicate slice (`planExcluding`)
// and the downstream-closure slice + validation (`planRestart`) live in
// `lifecycle/selective-restart.ts` and delegate the ordering here. Only
// the ordering choreography lives in `plan`; each caller owns its own
// slice computation.
//
// The supervisor flows then sequence the EXISTING `teardownKeys` /
// `acquireKeys` execution primitives over these orderings directly (a
// `drain` over `teardownOrder`, a `converge` over `acquireOrder`); there
// is no graph-axis reconcile wrapper — `plan` is pure ordering.

import type { PluginKey } from '../../brand.ts';
import {
	orderByLevel,
	type ResolvedGraph,
} from '../lifecycle/index.ts';

// -----------------------------------------------------------------------------
// plan — the single dep-ordering body
// -----------------------------------------------------------------------------

/** A dep-ordered reconcile plan over a slice of the graph. Both arrays
 *  cover exactly `slice`; they differ only in iteration direction
 *  (`teardownOrder` reverse-dep, `acquireOrder` forward-dep). */
export interface GraphPlan {
	readonly slice: ReadonlySet<PluginKey>;
	readonly teardownOrder: ReadonlyArray<PluginKey>;
	readonly acquireOrder: ReadonlyArray<PluginKey>;
}

/** Order a slice (carried on a `graph-keys` scope) into teardown +
 *  acquire orderings. Both orderings are always produced because a
 *  `drain∘converge` flow (selective-restart) needs both. Pure; delegates
 *  level math to the kept `orderByLevel`. */
export const plan = (
	graph: ResolvedGraph,
	scope: { readonly kind: 'graph-keys'; readonly keys: ReadonlyArray<PluginKey> },
): GraphPlan => {
	const slice = new Set<PluginKey>(scope.keys);
	const teardownOrder = orderByLevel(graph, slice, 'reverse');
	const acquireOrder = orderByLevel(graph, slice, 'forward');
	return { slice, teardownOrder, acquireOrder };
};
