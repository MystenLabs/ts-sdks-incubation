// Dep-graph resolution — turn a `Stack` member tuple into a topo-sorted
// acquire schedule.
//
// Architecture § Plugin lifecycle within a stack:
//   "Resolution. Upstream keys (concrete or capability-typed) resolve
//   once. Bootstrap asset dedup-by-key fires before the scheduler
//   starts node fibers. Scheduling. Plugin enters `pending`. When all
//   upstream keys are `ready`, the node begins `acquiring`. Per-key
//   serialization: only one acquire at a time per key."
//
// This module is the pure dep-graph math: members in, levels out.

import { Data, Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import { pluginKey as makePluginKey } from '../../brand.ts';
import { uniqueResourceRefs, type AnyPlugin, type AnyResourceRef } from '../../plugin.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Cycle detected in the dep graph. Carries the offending key path so
 *  the user sees the loop. Compile-time `defineDevstack` doesn't catch
 *  every cycle (capability-typed consumes resolve at runtime), so this
 *  surfaces a typed error at boot. */
export class DepGraphCycleError extends Data.TaggedError('DepGraphCycleError')<{
	readonly cycle: ReadonlyArray<PluginKey>;
}> {}

/** A dependency resource matched no provider. This is normally caught by
 *  the compile-time `MissingProviders` check, but runtime-built stacks can
 *  hit it. */
export class UnresolvedDependencyError extends Data.TaggedError('UnresolvedDependencyError')<{
	readonly pluginKey: PluginKey;
	readonly missingResourceId: string;
}> {}

/** Two members declared the same `resource id`. The compile-time
 *  `MissingProviders` check only catches collisions on the user-typed
 *  dependency path, NOT two members declared in the same stack with the
 *  same `definePlugin({ id })`. Without this guard the dep-graph would
 *  last-writer-wins the provider index and silently bind every dependent
 *  to the second declaration. Phase 22e/E3 added a complementary
 *  package-plugin-level guard (`plugins/package/mode-local.ts`) for the
 *  registry path; this surfaces the same class of mistake for ALL plugins
 *  at the substrate dep-graph layer. */
export class DuplicateResourceIdError extends Data.TaggedError('DuplicateResourceIdError')<{
	readonly resourceId: string;
	readonly firstPluginKey: PluginKey;
	readonly secondPluginKey: PluginKey;
}> {}

export type DepGraphError =
	| DepGraphCycleError
	| UnresolvedDependencyError
	| DuplicateResourceIdError;

// -----------------------------------------------------------------------------
// Node shape
// -----------------------------------------------------------------------------

/** A resolved node in the dep graph. Wraps the original plugin with a
 *  substrate-assigned `PluginKey`. */
export interface DepNode {
	readonly key: PluginKey;
	readonly member: AnyPlugin;
	/** Unique dependency refs and their resolved upstream keys. The two
	 *  arrays are positional peers. */
	readonly upstreamResources: ReadonlyArray<AnyResourceRef>;
	readonly upstreamKeys: ReadonlyArray<PluginKey>;
}

/** The result of resolving a member tuple. Levels are batches the
 *  scheduler can acquire in parallel; each level's nodes only depend
 *  on prior levels. */
export interface ResolvedGraph {
	readonly nodes: ReadonlyMap<PluginKey, DepNode>;
	readonly levels: ReadonlyArray<ReadonlyArray<PluginKey>>;
	/** Reverse-dep index: each key → keys that depend on it. The
	 *  supervisor uses this for selective-restart cascade. */
	readonly downstream: ReadonlyMap<PluginKey, ReadonlySet<PluginKey>>;
}

// -----------------------------------------------------------------------------
// Plugin key minting
// -----------------------------------------------------------------------------

interface NamedMember {
	readonly key: PluginKey;
	readonly member: AnyPlugin;
}

/** Mint a stable PluginKey for a plugin. Plugins may declare a stable
 *  key; otherwise keys derive from resource id + ordinal so duplicates
 *  do not collide. */
const mintKey = (member: AnyPlugin, ordinal: number): PluginKey => {
	if (member.pluginKey !== undefined) {
		return makePluginKey(String(member.pluginKey));
	}
	return makePluginKey(`${member.id}#${ordinal}`);
};

/** Walk the member tuple and emit one named-member entry per node. */
const expand = (members: ReadonlyArray<AnyPlugin>): ReadonlyArray<NamedMember> => {
	const out: NamedMember[] = [];
	let ordinal = 0;
	for (const member of members) {
		const key = mintKey(member, ordinal++);
		out.push({ key, member });
	}
	return out;
};

// -----------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// -----------------------------------------------------------------------------

/**
 * Resolve a flat member tuple into a topo-sorted level batch.
 *
 * Steps:
 *  1. Mint a plugin key for every member.
 *  2. Build the resource-id -> key index (providers). Two members with
 *     the same `id` fail with `DuplicateResourceIdError`.
 *  3. For each node, resolve its dependency refs to upstream keys.
 *  4. Kahn's algorithm: peel zero-indegree nodes into level 0, decrement
 *     downstream indegrees, repeat.
 *  5. If any node remains, return `DepGraphCycleError`.
 *
 * Span-instrumented so trace exports show the resolution alongside the
 * supervisor's acquire spans.
 */
export const resolveGraph = (
	members: ReadonlyArray<AnyPlugin>,
): Effect.Effect<ResolvedGraph, DepGraphError> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ 'devstack.dep-graph.memberCount': members.length });
		const named = expand(members);

		// Provider index: resource-id → key. The compile-time
		// `MissingProviders` check ensures uniqueness on the user-typed
		// dependency path, but a runtime-built stack (or a typo'd
		// `definePlugin({ id })`) can still ship two members with the
		// same `resource id`. Without an explicit guard the index would
		// last-writer-wins and every dependent would silently bind to
		// the second declaration; we fail early with a typed error
		// instead so a developer sees the conflicting plugin keys at
		// boot rather than chasing a "wrong provider" mystery downstream.
		// Phase 22e/E3's package-plugin-level guard in
		// `plugins/package/mode-local.ts` is complementary — it fires on
		// the registry path before this resolver runs.
		const providerByResourceId = new Map<string, PluginKey>();
		for (const { key, member } of named) {
			const existing = providerByResourceId.get(member.id);
			if (existing !== undefined) {
				return yield* Effect.fail(
					new DuplicateResourceIdError({
						resourceId: member.id,
						firstPluginKey: existing,
						secondPluginKey: key,
					}),
				);
			}
			providerByResourceId.set(member.id, key);
		}

		const nodes = new Map<PluginKey, DepNode>();
		const indegree = new Map<PluginKey, number>();
		const downstream = new Map<PluginKey, Set<PluginKey>>();
		for (const { key } of named) {
			indegree.set(key, 0);
			downstream.set(key, new Set());
		}

		for (const { key, member } of named) {
			const upstreamKeys: PluginKey[] = [];
			const upstreamResources = uniqueResourceRefs(member.dependsOn);
			for (const resource of upstreamResources) {
				const providerKey = providerByResourceId.get(resource.id);
				if (providerKey === undefined) {
					return yield* Effect.fail(
						new UnresolvedDependencyError({ pluginKey: key, missingResourceId: resource.id }),
					);
				}
				upstreamKeys.push(providerKey);
				downstream.get(providerKey)?.add(key);
				indegree.set(key, (indegree.get(key) ?? 0) + 1);
			}
			nodes.set(key, {
				key,
				member,
				upstreamResources,
				upstreamKeys,
			});
		}

		// Kahn's algorithm — peel zero-indegree nodes level by level.
		const levels: PluginKey[][] = [];
		const settled = new Set<PluginKey>();
		while (settled.size < nodes.size) {
			const layer: PluginKey[] = [];
			for (const [key, deg] of indegree) {
				if (settled.has(key)) continue;
				if (deg === 0) layer.push(key);
			}
			if (layer.length === 0) {
				// Cycle: collect every unsettled node as the cycle's witness.
				// More precise cycle extraction (Tarjan SCC) is overkill for
				// the user-facing message; we surface the trapped keys.
				const trapped: PluginKey[] = [];
				for (const key of nodes.keys()) {
					if (!settled.has(key)) trapped.push(key);
				}
				return yield* Effect.fail(new DepGraphCycleError({ cycle: trapped }));
			}
			levels.push(layer);
			for (const key of layer) {
				settled.add(key);
				for (const child of downstream.get(key) ?? []) {
					indegree.set(child, (indegree.get(child) ?? 1) - 1);
				}
			}
		}

		// Freeze downstream sets to ReadonlySet shape.
		const downstreamFrozen = new Map<PluginKey, ReadonlySet<PluginKey>>();
		for (const [k, v] of downstream) downstreamFrozen.set(k, v);

		return {
			nodes,
			levels,
			downstream: downstreamFrozen,
		} satisfies ResolvedGraph;
	}).pipe(Effect.withSpan('lifecycle.dep-graph.resolve'));

// -----------------------------------------------------------------------------
// Selective-restart helpers
// -----------------------------------------------------------------------------

/**
 * Compute the closure of nodes downstream of `root` (inclusive).
 * Used by the supervisor to tear down a subgraph in reverse-dep order
 * and re-acquire in forward order.
 *
 * Architecture § Watch-triggered invalidation:
 *   Invalidating a producer invalidates downstream consumers along
 *   dep-graph edges (cascade semantics).
 */
export const downstreamClosure = (
	graph: ResolvedGraph,
	root: PluginKey,
): ReadonlySet<PluginKey> => {
	const closure = new Set<PluginKey>([root]);
	const queue: PluginKey[] = [root];
	while (queue.length > 0) {
		const next = queue.shift()!;
		for (const child of graph.downstream.get(next) ?? []) {
			if (!closure.has(child)) {
				closure.add(child);
				queue.push(child);
			}
		}
	}
	return closure;
};

/** Order a set of keys by their dep-graph level — forward (low-to-high)
 *  for acquire, reverse (high-to-low) for teardown. */
export const orderByLevel = (
	graph: ResolvedGraph,
	keys: ReadonlySet<PluginKey>,
	direction: 'forward' | 'reverse',
): ReadonlyArray<PluginKey> => {
	const out: PluginKey[] = [];
	for (const level of graph.levels) {
		for (const key of level) if (keys.has(key)) out.push(key);
	}
	return direction === 'reverse' ? out.slice().reverse() : out;
};
