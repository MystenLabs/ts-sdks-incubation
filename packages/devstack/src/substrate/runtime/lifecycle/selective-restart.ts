// Selective-restart driver.
//
// Architecture § Watch-triggered invalidation:
//   "L0 watcher emits a debounced+deduped content-hash event. L3 watch
//   dispatcher consults plugin watch decls. Matched plugins enter
//   `selective-restart-pending`. Scheduler runs subset invalidate: evict
//   shadow-cache entry BEFORE closing scope; run finalizers (parallel
//   strategy); re-acquire."
//
// Architecture § Selective restart cascading:
//   "Invalidating a producer invalidates downstream consumers along
//   dep-graph edges (cascade semantics — engine already has this)."
//
// This module is the planner: given a set of root keys to invalidate,
// compute the downstream slice, order it for teardown and re-acquire.
// The actual `Scope.close` / `acquire` calls live in `supervisor.ts`
// so it can fold them into the per-cycle event stream.

import { Data, Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import { plan, type GraphPlan } from '../reconcile/graph.ts';
import { downstreamClosure, type DepNode, type ResolvedGraph } from './dep-graph.ts';

/** Tagged error: a restart was requested for a key that isn't in the
 *  graph. The supervisor lifts this from `attribute()` callers that
 *  somehow produced a stale key — defensive. */
export class RestartTargetMissing extends Data.TaggedError('RestartTargetMissing')<{
	readonly pluginKey: PluginKey;
}> {}

/**
 * Build a restart plan from a set of root invalidation targets. Each
 * root contributes its full downstream closure to the slice. The
 * downstream-closure slice computation + the root-membership validation
 * are this planner's unique work; the dep-ordering itself delegates to
 * the shared reconcile `plan` body, which returns a `GraphPlan`.
 */
export const planRestart = (
	graph: ResolvedGraph,
	roots: ReadonlySet<PluginKey>,
): Effect.Effect<GraphPlan, RestartTargetMissing> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ 'devstack.restart.rootCount': roots.size });
		for (const root of roots) {
			if (!graph.nodes.has(root)) {
				return yield* Effect.fail(new RestartTargetMissing({ pluginKey: root }));
			}
		}
		const slice = new Set<PluginKey>();
		for (const root of roots) {
			for (const key of downstreamClosure(graph, root)) slice.add(key);
		}
		return plan(graph, { kind: 'graph-keys', keys: [...slice] });
	}).pipe(Effect.withSpan('lifecycle.selective-restart.plan'));

/** Plan a drain + re-acquire of the whole graph MINUS the nodes matched by
 *  `exclude`. The excluded nodes stay live while every other plugin is
 *  drained + re-acquired.
 *
 *  The live `snapshot.restore` re-acquire passes a predicate over the
 *  plugin-declared keep-alive flag so a plugin whose transport is
 *  answering the restore isn't torn down mid-flight (which would surface
 *  to its caller as a 502 even though the restore succeeded). This module
 *  filters purely on the node flag — it has no knowledge of which plugins
 *  set it. `stack.restart` / CLI full-restart drains everything by passing
 *  the full key set straight to `plan`. */
export const planExcluding = (
	graph: ResolvedGraph,
	exclude: (node: DepNode) => boolean,
): GraphPlan => {
	const slice = new Set<PluginKey>();
	for (const [key, node] of graph.nodes) {
		if (!exclude(node)) slice.add(key);
	}
	return plan(graph, { kind: 'graph-keys', keys: [...slice] });
};
