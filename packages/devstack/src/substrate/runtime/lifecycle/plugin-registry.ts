// Per-plugin lifecycle bookkeeping.
//
// One `PluginEntry` per node in the resolved dep-graph. The entry
// holds:
//   - the live `LifecycleStatus` (Ref, single-fiber linearizable),
//   - the resolved value (set when status transitions to `ready`),
//   - the scope owning the plugin's `start` finalizers,
//   - a `Deferred` that downstream consumers await for the ready gate.
//
// Composite roll-up: inner participants' status transitions still
// flow through their own entries, but the supervisor consults
// `compositeParent` on the dep-graph node to decide whether to emit a
// projection row for the inner OR roll the narration into the parent
// row's `narrationByContributor`. The registry itself is parent-agnostic
// — it just tracks per-key lifecycle.

import { Data, Deferred, Effect, Ref, Scope } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { DepNode } from './dep-graph.ts';
import { assertTransition } from './state-machine.ts';

/** Per-registry side channel: synchronously-readable resolved values.
 *  Keyed by plugin key. Populated by `markReady`; consulted by the
 *  synchronous dependency reader. We can't put the value on the
 *  `Deferred` itself in a publicly-supported way, and plugin start
 *  receives dependency values synchronously; this is the safe escape hatch.
 *
 *  Module-private; only `makeRegistry` writes into the map it
 *  allocates. */
type ResolvedMap = Map<PluginKey, ResolvedValue>;

// -----------------------------------------------------------------------------
// Resolved-value shape
// -----------------------------------------------------------------------------

/** Erased resolved value held in the registry. The supervisor casts
 *  back to the concrete type at the boundary where it threads the
 *  value into a downstream plugin's resolved dependency object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResolvedValue = any;

// -----------------------------------------------------------------------------
// Per-plugin entry
// -----------------------------------------------------------------------------

/** Mutable lifecycle state for one plugin instance. */
export interface PluginEntry {
	readonly node: DepNode;
	readonly statusRef: Ref.Ref<LifecycleStatus>;
	/** Resolved when the plugin reaches `ready`. Downstream consumers
	 *  await this in the ready-gate. Failure is propagated by interruption
	 *  via `Deferred.fail` to keep the error chain in the cause walker. */
	readonly readyGate: Deferred.Deferred<ResolvedValue, PluginAcquireFailed>;
	/** Per-plugin Scope. Closing it runs the `start` finalizers. */
	readonly scope: Scope.Closeable;
}

/** Tagged failure: a plugin's `start` rejected. Carries the cause and
 *  the failing plugin's key so the cause walker / cascade formatter can
 *  attribute it. */
export class PluginAcquireFailed extends Data.TaggedError('PluginAcquireFailed')<{
	readonly pluginKey: PluginKey;
	readonly cause: unknown;
}> {}

/** Tagged failure: a downstream plugin tried to read a resolved value
 *  whose entry isn't registered or hasn't reached `ready`. Programmer-
 *  level error class — the dep-graph guarantees this can't happen on
 *  the supervisor's own scheduling path. Surfaced when a plugin author
 *  reaches outside their declared dependencies. */
export class UnknownDependency extends Data.TaggedError('UnknownDependency')<{
	readonly pluginKey: PluginKey;
	readonly requestedResourceId: string;
}> {}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

/** Build a fresh entry for `node`. Caller still owns the entry — the
 *  registry below holds a `ReadonlyMap` of these. */
export const makeEntry = (
	node: DepNode,
	parentScope: Scope.Scope,
): Effect.Effect<PluginEntry, never, never> =>
	Effect.gen(function* () {
		const statusRef = yield* Ref.make<LifecycleStatus>('pending');
		const readyGate = yield* Deferred.make<ResolvedValue, PluginAcquireFailed>();
		const scope = yield* Scope.fork(parentScope);
		return { node, statusRef, readyGate, scope } satisfies PluginEntry;
	});

/** The lifecycle registry. Holds one entry per dep-graph node. */
export interface PluginRegistry {
	readonly entries: ReadonlyMap<PluginKey, PluginEntry>;
	/** Read a plugin's current status. */
	readonly getStatus: (key: PluginKey) => Effect.Effect<LifecycleStatus, UnknownDependency>;
	/** Transition a plugin to a new status. Validates against the
	 *  transition table; emits via `onTransition`. */
	readonly transition: (
		key: PluginKey,
		to: LifecycleStatus,
	) => Effect.Effect<
		{ readonly from: LifecycleStatus; readonly to: LifecycleStatus },
		UnknownDependency
	>;
	/** Mark a plugin ready with its resolved value. */
	readonly markReady: (
		key: PluginKey,
		value: ResolvedValue,
	) => Effect.Effect<void, UnknownDependency>;
	/** Mark a plugin failed. */
	readonly markFailed: (key: PluginKey, cause: unknown) => Effect.Effect<void, UnknownDependency>;
	/** Await `ready` for `key`. Suspends until the plugin's `readyGate`
	 *  resolves. The deferred's failure channel propagates a
	 *  `PluginAcquireFailed` so the supervisor's outer error path picks
	 *  it up. */
	readonly awaitReady: (
		key: PluginKey,
	) => Effect.Effect<ResolvedValue, PluginAcquireFailed | UnknownDependency>;
}

/** Build a registry from a map of entries. The `onTransition` callback
 *  is the supervisor's published event sink — every status change
 *  flows through here. */
export const makeRegistry = (
	entries: ReadonlyMap<PluginKey, PluginEntry>,
	onTransition: (key: PluginKey, from: LifecycleStatus, to: LifecycleStatus) => Effect.Effect<void>,
): PluginRegistry => {
	const resolved: ResolvedMap = new Map();

	const getEntry = (key: PluginKey): Effect.Effect<PluginEntry, UnknownDependency> => {
		const entry = entries.get(key);
		if (entry === undefined) {
			return Effect.fail(new UnknownDependency({ pluginKey: key, requestedResourceId: '' }));
		}
		return Effect.succeed(entry);
	};

	const reg: PluginRegistry & { __resolved: ResolvedMap } = {
		entries,
		__resolved: resolved,
		getStatus: (key) =>
			Effect.gen(function* () {
				const entry = yield* getEntry(key);
				return yield* Ref.get(entry.statusRef);
			}),
		transition: (key, to) =>
			Effect.gen(function* () {
				const entry = yield* getEntry(key);
				const from = yield* Ref.get(entry.statusRef);
				yield* assertTransition(from, to);
				yield* Ref.set(entry.statusRef, to);
				yield* onTransition(key, from, to);
				return { from, to };
			}),
		markReady: (key, value) =>
			Effect.gen(function* () {
				const entry = yield* getEntry(key);
				const from = yield* Ref.get(entry.statusRef);
				resolved.set(key, value);
				if (from !== 'ready') {
					// `pending → ready` is off-table — the state machine
					// requires the intermediate `acquiring` hop. Bridge it
					// here so callers reaching `markReady` from a `pending`
					// entry (test fixtures, callers that mark a synthetic
					// already-resolved value) don't have to pre-walk the
					// machine. Both transitions still emit through
					// `onTransition` so subscribers see the full path.
					if (from === 'pending') {
						yield* assertTransition(from, 'acquiring');
						yield* Ref.set(entry.statusRef, 'acquiring');
						yield* onTransition(key, from, 'acquiring');
						yield* assertTransition('acquiring', 'ready');
						yield* Ref.set(entry.statusRef, 'ready');
						yield* onTransition(key, 'acquiring', 'ready');
					} else {
						yield* assertTransition(from, 'ready');
						yield* Ref.set(entry.statusRef, 'ready');
						yield* onTransition(key, from, 'ready');
					}
				}
				yield* Deferred.succeed(entry.readyGate, value);
			}),
		markFailed: (key, cause) =>
			Effect.gen(function* () {
				const entry = yield* getEntry(key);
				const from = yield* Ref.get(entry.statusRef);
				yield* assertTransition(from, 'failed');
				yield* Ref.set(entry.statusRef, 'failed');
				yield* onTransition(key, from, 'failed');
				yield* Deferred.fail(entry.readyGate, new PluginAcquireFailed({ pluginKey: key, cause }));
			}),
		awaitReady: (key) =>
			Effect.gen(function* () {
				const entry = yield* getEntry(key);
				return yield* Deferred.await(entry.readyGate);
			}),
	};
	return reg;
};

/** Synchronous accessor: snapshot the resolved value for `key`.
 *  Returns `undefined` if the plugin isn't ready yet OR isn't
 *  registered. The supervisor guarantees readiness before any
 *  consumer calls this; it's the ONLY synchronous path. */
export const readResolvedSync = (
	registry: PluginRegistry,
	key: PluginKey,
): ResolvedValue | undefined => {
	const resolved = (registry as PluginRegistry & { __resolved?: ResolvedMap }).__resolved;
	return resolved?.get(key);
};

// -----------------------------------------------------------------------------
// Dependency reader over the registry
// -----------------------------------------------------------------------------

/**
 * Build a synchronous dependency reader over the registry for one
 * plugin. The upstream key must already be `ready`; the supervisor
 * ensures this by awaiting upstream ready-gates before invoking start.
 */
export const buildDependencyReaderFor = (
	registry: PluginRegistry,
	node: DepNode,
): ((resource: { readonly id: string }) => unknown) => {
	// Pre-build a resource-id → upstream-key index for this node so the
	// lookups are O(1) instead of scanning dependencies.
	const resourceIdToKey = new Map<string, PluginKey>();
	node.upstreamResources.forEach((resource, i) => {
		const upstream = node.upstreamKeys[i];
		if (upstream !== undefined) resourceIdToKey.set(resource.id, upstream);
	});
	return (resource): unknown => {
		const key = resourceIdToKey.get(resource.id);
		if (key === undefined) {
			// Programmer error: the plugin reached outside its declared
			// dependencies. The type system normally rules this out — defending
			// here keeps the runtime honest in the face of cast escapes.
			throw new Error(
				`DependencyReader: resource '${resource.id}' not in this plugin's declared dependencies`,
			);
		}
		const value = readResolvedSync(registry, key);
		if (value === undefined) {
			throw new Error(
				`DependencyReader: upstream '${key}' has no resolved value yet — ` +
					'supervisor must mark the entry ready before downstream acquire.',
			);
		}
		return value;
	};
};
