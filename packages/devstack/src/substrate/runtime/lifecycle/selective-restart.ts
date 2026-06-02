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
import { downstreamClosure, orderByLevel, type ResolvedGraph } from './dep-graph.ts';

/** Tagged error: a restart was requested for a key that isn't in the
 *  graph. The supervisor lifts this from `attribute()` callers that
 *  somehow produced a stale key — defensive. */
export class RestartTargetMissing extends Data.TaggedError('RestartTargetMissing')<{
	readonly pluginKey: PluginKey;
}> {}

/** A planned slice of work for selective restart. The supervisor:
 *  1. Tears down `teardownOrder` (reverse-dep, parallel-within-level).
 *  2. Re-acquires `acquireOrder` (forward, level-batched-parallel).
 *
 *  The two arrays cover the same set of keys; the difference is the
 *  iteration direction. */
export interface RestartPlan {
	readonly slice: ReadonlySet<PluginKey>;
	readonly teardownOrder: ReadonlyArray<PluginKey>;
	readonly acquireOrder: ReadonlyArray<PluginKey>;
}

/**
 * Build a restart plan from a set of root invalidation targets. Each
 * root contributes its full downstream closure to the slice.
 */
export const planRestart = (
	graph: ResolvedGraph,
	roots: ReadonlySet<PluginKey>,
): Effect.Effect<RestartPlan, RestartTargetMissing> =>
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
		const teardownOrder = orderByLevel(graph, slice, 'reverse');
		const acquireOrder = orderByLevel(graph, slice, 'forward');
		return { slice, teardownOrder, acquireOrder } satisfies RestartPlan;
	}).pipe(Effect.withSpan('lifecycle.selective-restart.plan'));

/**
 * Drain plan — for `stack.stop` and graceful shutdown. All keys in
 * dep-graph order, reverse. Architecture § Stack lifecycle:
 *   "shutdown.requested → parallel teardown (max grace, not sum grace)"
 *
 * The "parallel within a level" semantics live in the supervisor's
 * execution loop; this planner just produces the level batches in
 * reverse.
 */
export const planFullDrain = (graph: ResolvedGraph): RestartPlan => {
	const slice = new Set<PluginKey>(graph.nodes.keys());
	const teardownOrder = orderByLevel(graph, slice, 'reverse');
	const acquireOrder = orderByLevel(graph, slice, 'forward');
	return { slice, teardownOrder, acquireOrder };
};

/** Plugin ids that are the operator's own transport and hold no
 *  restorable chain state — excluded from the live `snapshot.restore`
 *  re-acquire. Leaving them running is safe: the dashboard's view derives
 *  from the in-process projection (re-acquired anyway), and host-service
 *  processes read chain over the network at stable hostnames. Excluding
 *  them stops a dashboard-initiated restore from tearing down the very
 *  connection it's answering on (which surfaces to the UI as a 502 even
 *  though the restore succeeded). `stack.restart` / CLI full-restart still
 *  drains everything via `planFullDrain`. Key shape is `${id}#${ordinal}`. */
export const isNonRestorableTransport = (key: PluginKey): boolean => {
	const raw = String(key);
	const hash = raw.indexOf('#');
	const id = hash === -1 ? raw : raw.slice(0, hash);
	return id === 'dashboard' || id.startsWith('host-service/');
};

/** `planFullDrain` minus the keys matched by `exclude`. The excluded
 *  nodes stay live while every other plugin (all chain-stateful services)
 *  is drained + re-acquired. */
export const planFullDrainExcluding = (
	graph: ResolvedGraph,
	exclude: (key: PluginKey) => boolean,
): RestartPlan => {
	const slice = new Set<PluginKey>();
	for (const key of graph.nodes.keys()) {
		if (!exclude(key)) slice.add(key);
	}
	const teardownOrder = orderByLevel(graph, slice, 'reverse');
	const acquireOrder = orderByLevel(graph, slice, 'forward');
	return { slice, teardownOrder, acquireOrder };
};
