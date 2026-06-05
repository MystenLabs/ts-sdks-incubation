// Reconcile over the dep-graph.
//
// Two pieces:
//
//   1. `plan(graph, scope)` — the single dep-ordering body.
//      Given a slice (carried on a `graph-keys` scope) it produces the
//      teardown (reverse-dep) and acquire (forward-dep) orderings via the
//      kept `orderByLevel` level-ordering helper. Full-graph drains call
//      it directly with every key; the exclude-predicate slice
//      (`planExcluding`) and the downstream-closure slice + validation
//      (`planRestart`) live in `lifecycle/selective-restart.ts` and
//      delegate the ordering here. Only the ordering choreography lives in
//      `plan`; each caller owns its own slice computation.
//
//   2. `reconcileGraph(spec, deps)` — sequences `plan` then the EXISTING
//      `acquireKeys` / `teardownKeys` execution primitives by the spec's
//      direction. It does NOT re-implement acquire/teardown. The graph
//      axis handles ONLY `scope.kind === 'graph-keys'` + `converge | drain`;
//      fsPlan execution in the graph axis is an unwired seam (marked TODO
//      below — the TYPE already accepts it).
//
// `decideRunAction` / `ensureContainer` are untouched — reconcileGraph
// only chooses target/direction and never re-implements per-container
// action execution.

import { Context, Effect, Queue, SubscriptionRef } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { SubscribableState } from '../../projection.ts';
import {
	orderByLevel,
	type PluginRegistry,
	type ResolvedGraph,
} from '../lifecycle/index.ts';
import type { LoggerShape } from '../observability/index.ts';
import { acquireKeys } from '../supervisor/acquire-node.ts';
import type { ContributionDispatcher } from '../supervisor/contribution-dispatcher.ts';
import { teardownKeys } from '../supervisor/teardown.ts';
import type { ReconcileSpec } from './spec.ts';

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

// -----------------------------------------------------------------------------
// reconcileGraph — sequence plan ∘ {teardown,acquire} by spec
// -----------------------------------------------------------------------------

/** Everything `reconcileGraph` needs to drive the kept acquire/teardown
 *  primitives. Mirrors the argument lists of `acquireKeys` /
 *  `doSelectiveRestart` so the call sites pass through unchanged. */
export interface ReconcileGraphDeps {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly ref: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly hub: Queue.Enqueue<EngineEvent>;
	readonly pluginContext: Context.Context<never>;
	readonly dispatcher: ContributionDispatcher;
	readonly logger: LoggerShape;
	readonly identity: Identity;
}

/**
 * Reconcile a graph-keys slice toward the spec's direction by sequencing
 * the kept execution primitives:
 *
 *   - `drain`     → `teardownKeys` over the reverse-dep order.
 *   - `converge`  → re-acquire the slice via `acquireKeys` over the
 *                   forward-dep order.
 *
 * This is the EXECUTION seam for the graph axis only. It does NOT own the
 * selective-restart event choreography (`restart.*` settle events,
 * `resetForRestart`) — that stays in `doSelectiveRestart`, which calls
 * `reconcileGraph(drain)` then `reconcileGraph(converge)` around its own
 * reset + event publishing. `reconcileGraph` is purely the "plan then
 * sequence the two primitives" body.
 *
 * `acquireKeys` / `teardownKeys` are unchanged; the per-container
 * orphan-safety window stays inside `ensureContainer`. This function
 * never picks a docker action.
 */
export const reconcileGraph = (
	spec: ReconcileSpec,
	deps: ReconcileGraphDeps,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		// Label scope is the FLAT out-of-supervisor sweep — it has no
		// dep-graph to order, so it lives in the sibling `reconcileLabel`
		// (`./label.ts`), which the wipe / prune flows call directly.
		// The graph axis handles ONLY `graph-keys` (dep-ordered,
		// in-supervisor); a label spec reaching here is a wiring bug.
		if (spec.scope.kind !== 'graph-keys') {
			return yield* Effect.die(
				'reconcileGraph: label-scope specs go through reconcileLabel (./label.ts), ' +
					'not the graph axis — the graph axis handles graph-keys scope only',
			);
		}
		// TODO: graph-axis fsPlan execution over the unchanged
		// `stageAndSwap` vocabulary (up/down/restart carry none today;
		// codegen's swap-tree lands as a sibling). `spec.fsPlan` is
		// typed-but-inert in the graph axis.

		const built = plan(deps.graph, spec.scope);
		if (spec.direction === 'drain') {
			yield* teardownKeys(deps.graph, deps.registry, built.teardownOrder);
		} else {
			yield* acquireKeys(
				deps.registry,
				built.acquireOrder,
				deps.ref,
				deps.hub,
				deps.pluginContext,
				deps.dispatcher,
				deps.logger,
				deps.identity,
			);
		}
	}).pipe(Effect.withSpan('lifecycle.reconcile.graph'));
