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
import { type CapabilitySinksShape } from '../capability-sinks/index.ts';
import type { LoggerShape } from '../observability/index.ts';
import {
	planRestart,
	type PluginRegistry,
	type ResolvedGraph,
	type RestartTargetMissing,
} from '../lifecycle/index.ts';
import { acquireKeys } from './acquire-node.ts';
import { publish } from './wiring.ts';

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
		// are no-ops.
		if (status === 'ready') {
			yield* registry.transition(key, 'stopping').pipe(Effect.catch(() => Effect.void));
		}
		yield* Scope.close(entry.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
		if (status === 'ready') {
			yield* registry.transition(key, 'stopped').pipe(Effect.catch(() => Effect.void));
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
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
	parentScope: Scope.Scope,
): Effect.Effect<void, RestartTargetMissing> =>
	Effect.gen(function* () {
		const plan = yield* planRestart(graph, roots);
		const at = Date.now();
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.requested',
				target: { pluginKey: root },
				at,
			});
		}
		yield* teardownKeys(graph, registry, plan.teardownOrder);
		// Re-acquire the slice in parallel. Each node waits on its own
		// upstream ready gate, so a downstream node in the slice can't
		// acquire until its upstream is back to `ready`; unrelated
		// siblings do not act as a level barrier. Nodes outside the
		// slice are already `ready`. We need to mark slice nodes back
		// to `pending` so the state
		// machine accepts the `pending → acquiring` transition.
		for (const key of plan.acquireOrder) {
			yield* registry.resetForRestart(key, parentScope).pipe(Effect.catch(() => Effect.void));
			yield* registry.transition(key, 'pending').pipe(Effect.catch(() => Effect.void));
		}
		yield* acquireKeys(
			registry,
			plan.acquireOrder,
			ref,
			hub,
			pluginContext,
			sinks,
			logger,
			identity,
			runtimeRoot,
		);
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.completed',
				target: { pluginKey: root },
				at: Date.now(),
			});
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.selectiveRestart'));
