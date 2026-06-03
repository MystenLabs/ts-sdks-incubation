// Teardown + selective restart.
//
// Plugin scopes close in reverse-dep order, parallel within each level
// (max grace, not sum grace, per architecture § Stack lifecycle).
// Selective restart tears a slice down then re-acquires it in
// dependency order, reusing the per-node acquire pipeline.

import { Context, Effect, Exit, Queue, Scope, SubscriptionRef } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { SubscribableState } from '../../projection.ts';
import { type ContributionDispatcher } from './contribution-dispatcher.ts';
import type { LoggerShape } from '../observability/index.ts';
import {
	planRestart,
	type PluginRegistry,
	type ResolvedGraph,
	type RestartTargetMissing,
} from '../lifecycle/index.ts';
import { reconcileGraph, type ReconcileGraphDeps } from '../reconcile/graph.ts';
import { graphKeysScope, reconcileSpec, reuseVerifiedPolicy } from '../reconcile/spec.ts';
import { bestEffort, publish } from './wiring.ts';

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

/**
 * Tear down a slice in reverse-dep order, parallel within each level.
 * Each node's scope close runs its finalizers; status transitions
 * `ready → stopping → stopped` are emitted.
 *
 * Architecture § Stack lifecycle: "shutdown.requested → parallel
 * teardown (max grace, not sum grace)".
 */
export const teardownKeys = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	keys: ReadonlyArray<PluginKey>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const byLevel: Array<Array<PluginKey>> = graph.levels.map(() => []);
		const keySet = new Set(keys);
		for (let i = 0; i < graph.levels.length; i++) {
			for (const key of graph.levels[i]!) {
				if (keySet.has(key)) byLevel[i]!.push(key);
			}
		}
		for (let i = byLevel.length - 1; i >= 0; i--) {
			const level = byLevel[i]!;
			if (level.length === 0) continue;
			yield* Effect.all(
				level.map((key) => teardownNode(registry, key)),
				{ concurrency: 'unbounded', discard: true },
			);
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.teardownKeys'));

export const teardownNode = (
	registry: PluginRegistry,
	key: PluginKey,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const entry = registry.entries.get(key);
		if (entry === undefined) return;
		const status = yield* registry
			.getStatus(key)
			.pipe(Effect.catch(() => Effect.succeed<LifecycleStatus>('pending')));
		// Only `ready` plugins need stopping. `acquiring` plugins are
		// interrupted by the scope close. `failed` / `stopped` / `done`
		// are no-ops. `status` is a snapshot read above, so a concurrent
		// off-table move (e.g. a racing restart driving the node to
		// `failed`) can make `transition` hit `assertTransition` and
		// `Effect.die` — `bestEffort` (Effect.exit) swallows that defect
		// as well as the typed channel, keeping teardown's unbounded
		// fan-out from bubbling an unguarded die through the scope-close
		// finalizer.
		if (status === 'ready') {
			yield* bestEffort(registry.transition(key, 'stopping'));
		}
		yield* Scope.close(entry.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
		if (status === 'ready') {
			yield* bestEffort(registry.transition(key, 'stopped'));
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.teardownNode'));

// -----------------------------------------------------------------------------
// Selective restart
// -----------------------------------------------------------------------------

export const doSelectiveRestart = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	roots: ReadonlySet<PluginKey>,
	pluginContext: Context.Context<never>,
	dispatcher: ContributionDispatcher,
	logger: LoggerShape,
	identity: Identity,
	parentScope: Scope.Scope,
): Effect.Effect<void, RestartTargetMissing> =>
	Effect.gen(function* () {
		// `planRestart` computes the downstream-closure slice (and validates
		// every root is in the graph → `RestartTargetMissing`). The reconcile
		// of that slice is then a `drain ∘ converge` over the SAME graph-keys
		// scope, sequenced through `reconcileGraph` (the kept `teardownKeys` /
		// `acquireKeys` primitives — selective-restart no longer calls them
		// directly). The `restart.*` settle events + the `resetForRestart`
		// reset between drain and converge stay HERE — that choreography is
		// selective-restart-specific, not part of the generic graph reconcile.
		const restartPlan = yield* planRestart(graph, roots);
		const scope = graphKeysScope(restartPlan.acquireOrder);
		const deps: ReconcileGraphDeps = {
			graph,
			registry,
			ref,
			hub,
			pluginContext,
			dispatcher,
			logger,
			identity,
			parentScope,
		};
		const at = Date.now();
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.requested',
				target: { pluginKey: root },
				at,
			});
		}
		yield* reconcileGraph(
			reconcileSpec({
				target: 'absent',
				cachePolicy: reuseVerifiedPolicy(),
				scope,
				direction: 'drain',
			}),
			deps,
		);
		// Re-acquire the slice in parallel. Each node waits on its own
		// upstream ready gate, so a downstream node in the slice can't
		// acquire until its upstream is back to `ready`; unrelated
		// siblings do not act as a level barrier. Nodes outside the
		// slice are already `ready`. `resetForRestart` rebuilds each
		// node's scope + ready gate AND authoritatively resets its
		// status to `pending` regardless of prior state (a node may
		// still be `acquiring` when its scope close interrupts it), so
		// the acquire below performs a clean `pending → acquiring`
		// transition for every slice node.
		for (const key of restartPlan.acquireOrder) {
			yield* registry.resetForRestart(key, parentScope).pipe(Effect.catch(() => Effect.void));
		}
		yield* reconcileGraph(
			reconcileSpec({
				target: 'running',
				cachePolicy: reuseVerifiedPolicy(),
				scope,
				direction: 'converge',
			}),
			deps,
		);
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.completed',
				target: { pluginKey: root },
				at: Date.now(),
			});
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.selectiveRestart'));
