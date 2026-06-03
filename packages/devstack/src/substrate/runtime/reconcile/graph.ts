// Reconcile over the dep-graph — P1.
//
// Two pieces:
//
//   1. `plan(graph, scope, direction)` — the single dep-ordering body
//      that subsumes the three former plan wrappers (`planFullDrain`,
//      `planFullDrainExcluding`, `planRestart`). Given a slice (carried on
//      a `graph-keys` scope) it produces the teardown (reverse-dep) and
//      acquire (forward-dep) orderings via the kept `orderByLevel`
//      level-ordering helper. The slice-COMPUTATION (full / exclude /
//      downstream-closure) stays with each former caller; only the
//      identical ordering choreography is collapsed here.
//
//   2. `reconcileGraph(spec, deps)` — sequences `plan` then the EXISTING
//      `acquireKeys` / `teardownKeys` execution primitives by the spec's
//      direction. It does NOT re-implement acquire/teardown. Phase A
//      handles ONLY `scope.kind === 'graph-keys'` + `converge | drain`;
//      label-scope, fsPlan and cachePolicy execution are later-phase
//      seams (clearly marked TODO below — the TYPES already accept them).
//
// Guardrails (redesign §3): `decideRunAction` / `ensureContainer` are
// untouched — reconcileGraph only chooses target/direction and never
// re-implements per-container action execution.

import { Context, Effect, Queue, Scope, SubscriptionRef } from 'effect';

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
 *  (`teardownOrder` reverse-dep, `acquireOrder` forward-dep). This is the
 *  shape the three former plan wrappers returned. */
export interface GraphPlan {
	readonly slice: ReadonlySet<PluginKey>;
	readonly teardownOrder: ReadonlyArray<PluginKey>;
	readonly acquireOrder: ReadonlyArray<PluginKey>;
}

/** Order a slice (carried on a `graph-keys` scope) into teardown +
 *  acquire orderings. The `direction` argument names the PRIMARY intent of
 *  the caller — but both orderings are always produced because a
 *  `drain∘converge` flow (selective-restart) needs both. Pure; delegates
 *  level math to the kept `orderByLevel`. */
export const plan = (
	graph: ResolvedGraph,
	scope: { readonly kind: 'graph-keys'; readonly keys: ReadonlyArray<PluginKey> },
	_direction: 'converge' | 'drain',
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
	/** The supervisor's outer scope — needed by `converge` callers that
	 *  rebuild per-node scopes (`resetForRestart`) around the reconcile.
	 *  `reconcileGraph` itself never reads it (drain/converge only sequence
	 *  the kept primitives); it's optional so a pure `drain` caller
	 *  (shutdown) needn't fabricate one. */
	readonly parentScope?: Scope.Scope;
}

/**
 * Reconcile a graph-keys slice toward the spec's direction by sequencing
 * the kept execution primitives:
 *
 *   - `drain`     → `teardownKeys` over the reverse-dep order.
 *   - `converge`  → re-acquire the slice via `acquireKeys` over the
 *                   forward-dep order.
 *
 * Phase A scope: this is the EXECUTION seam for the graph axis only. It
 * does NOT own the selective-restart event choreography (`restart.*`
 * settle events, `resetForRestart`) — that stays in `doSelectiveRestart`,
 * which now calls `reconcileGraph(drain)` then `reconcileGraph(converge)`
 * around its own reset + event publishing. `reconcileGraph` is purely the
 * "plan then sequence the two primitives" body.
 *
 * Guardrails: `acquireKeys` / `teardownKeys` are unchanged; the per-
 * container orphan-safety window stays inside `ensureContainer`. This
 * function never picks a docker action.
 */
export const reconcileGraph = (
	spec: ReconcileSpec,
	deps: ReconcileGraphDeps,
): Effect.Effect<GraphPlan, never, never> =>
	Effect.gen(function* () {
		// TODO(P3): label-scope sweep — out-of-supervisor flat resource
		// removal (wipe / prune / capture). The TYPES already accept
		// `scope.kind === 'label'`; the executor lands with the snapshot
		// routing phases.
		if (spec.scope.kind !== 'graph-keys') {
			return yield* Effect.die(
				'reconcileGraph: label-scope execution is a later-phase seam (P3+); ' +
					'Phase A handles graph-keys scope only',
			);
		}
		// TODO(P2): fsPlan execution over the unchanged `stageAndSwap`
		// vocabulary. `spec.fsPlan` is typed-but-inert here.
		// TODO(P2/P3): cachePolicy execution (cache + snapshots
		// dispositions). `spec.cachePolicy` is carried but not enforced in
		// the graph axis yet — up/restart both ride `reuse-verified` today,
		// which is the existing cache lookup→verify→reuse loop (untouched).
		// TODO(P4/P6): `spec.precondition` / `spec.locks` / `spec.ownership`
		// riders.

		const built = plan(deps.graph, spec.scope, spec.direction);
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
		return built;
	}).pipe(Effect.withSpan('lifecycle.reconcile.graph'));
