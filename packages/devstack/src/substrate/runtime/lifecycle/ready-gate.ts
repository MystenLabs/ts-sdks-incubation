// Ready-gate composition over `PluginRegistry`.
//
// Architecture § Plugin lifecycle within a stack § Ready gate:
//   "Plugin's acquire procedure returns the resolved value + capability
//   decls. Substrate writes them to the typed registries. Plugin
//   transitions to `ready`. Downstream consumers are unblocked."
//
// This module provides the small `awaitAllReady` / `awaitUpstreams`
// helpers the supervisor's acquire loop calls. The actual `Deferred`
// machinery lives on `PluginRegistry`; here we just compose them with
// span instrumentation and short-circuit on the first upstream
// failure.

import { Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { DepNode } from './dep-graph.ts';
import type { PluginAcquireFailed, PluginRegistry, UnknownDependency } from './plugin-registry.ts';

/**
 * Wait for every upstream of `node` to reach `ready`. Returns when
 * they all have; short-circuits on the first upstream failure (the
 * failed deferred propagates `PluginAcquireFailed`).
 *
 * Architecture § Scheduling: "When all upstream keys are `ready`,
 * scheduler begins `acquiring`."
 */
export const awaitUpstreams = (
	registry: PluginRegistry,
	node: DepNode,
): Effect.Effect<void, PluginAcquireFailed | UnknownDependency> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'devstack.plugin.key': node.key,
			'devstack.plugin.upstreamCount': node.upstreamKeys.length,
		});
		if (node.upstreamKeys.length === 0) return;
		// Parallelize the awaits — every upstream's ready-gate resolves
		// once (or fails once); racing them is the right shape.
		yield* Effect.all(
			node.upstreamKeys.map((key) => registry.awaitReady(key)),
			{ concurrency: 'unbounded', discard: true },
		);
	}).pipe(Effect.withSpan('lifecycle.ready-gate.awaitUpstreams'));

/**
 * Wait for every plugin in `keys` to reach `ready`. Used by the
 * supervisor's "stack is ready" gate after the level-batched parallel
 * acquire completes.
 */
export const awaitAll = (
	registry: PluginRegistry,
	keys: ReadonlyArray<PluginKey>,
): Effect.Effect<void, PluginAcquireFailed | UnknownDependency> =>
	Effect.all(
		keys.map((key) => registry.awaitReady(key)),
		{ concurrency: 'unbounded', discard: true },
	).pipe(Effect.withSpan('lifecycle.ready-gate.awaitAll'));
