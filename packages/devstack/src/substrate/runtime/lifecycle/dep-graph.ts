// Dep-graph resolution — turn a `Stack` member tuple into a topo-sorted
// acquire schedule.
//
// Architecture § Plugin lifecycle within a stack:
//   "Resolution. Upstream keys (concrete or capability-typed) resolve
//   once. Lifted-sibling dedup-by-key fires before scheduler emits the
//   level-0 batch. Scheduling. Plugin enters `pending`. When all
//   upstream keys are `ready`, scheduler begins `acquiring`. Per-key
//   serialization: only one acquire at a time per key."
//
// This module is the pure dep-graph math: members in, levels out.
// Composite plugins are expanded transparently — their inner members
// land in the same level batch they'd land in if declared at top level
// (architecture: lifted siblings at level 0). Lifecycle roll-up
// (composite row stays one row in the projection) is the supervisor's
// concern — the dep-graph treats inner members as first-class nodes.

import { Data, Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import { pluginKey as makePluginKey } from '../../brand.ts';
import { uniqueResourceRefs, type AnyPlugin, type AnyResourceRef } from '../../plugin.ts';
import type { CapabilityDecl } from '../../../contracts/index.ts';
import type { CompositePrimitiveDecl } from '../../../contracts/composite-primitive.ts';

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
 *  the compile-time `MissingProviders` check, but runtime composites
 *  whose dependencies expand from a runtime parameter can hit it. */
export class UnresolvedDependencyError extends Data.TaggedError('UnresolvedDependencyError')<{
	readonly pluginKey: PluginKey;
	readonly missingResourceId: string;
}> {}

export type DepGraphError = DepGraphCycleError | UnresolvedDependencyError;

// -----------------------------------------------------------------------------
// Node shape
// -----------------------------------------------------------------------------

/** A resolved node in the dep graph. Wraps the original plugin
 *  with a substrate-assigned `PluginKey` and the flattened
 *  parent-composite key (if this node is an inner participant). */
export interface DepNode {
	readonly key: PluginKey;
	readonly member: AnyPlugin;
	/** Composite parent key — present when this node is a lifted inner
	 *  participant; null for top-level members. Used by the supervisor
	 *  to roll lifecycle into the composite row. */
	readonly compositeParent: PluginKey | null;
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
// Composite expansion
// -----------------------------------------------------------------------------

interface NamedMember {
	readonly key: PluginKey;
	readonly member: AnyPlugin;
	readonly compositeParent: PluginKey | null;
}

/**
 * Read the static `capabilities` array off a member if and only if it
 * is an array. The `capabilities` field can be either a static tuple
 * OR a dynamic factory `(resolved, acquireCtx) => Caps` (see
 * `Plugin.capabilities`); the dep-graph runs BEFORE start, so
 * a dynamic factory's output is not yet available here.
 *
 * Convention: `composite-primitive` decls MUST be static (the
 * dep-graph needs the topology before any acquire fires). Dynamic
 * factories are reserved for snapshot/codegen/routable/strategy
 * decls whose values depend on acquire-resolved data.
 */
const readStaticCapabilities = (member: AnyPlugin): ReadonlyArray<CapabilityDecl> => {
	const caps = member.capabilities;
	if (caps === undefined) return [];
	if (typeof caps === 'function') return [];
	return caps;
};

const isCompositePrimitiveDecl = (decl: CapabilityDecl): decl is CompositePrimitiveDecl =>
	decl.kind === 'composite-primitive' &&
	'compositeKey' in decl &&
	'innerParticipants' in decl;

/** Mint a stable PluginKey for a plugin. Composites have a declared
 *  `compositeKey` on their `CompositePrimitiveDecl`; leaves derive
 *  from the resource id + an ordinal so duplicates don't collide. */
const mintKey = (member: AnyPlugin, ordinal: number): PluginKey => {
	const composite = readStaticCapabilities(member).find(isCompositePrimitiveDecl);
	if (composite !== undefined) {
		return composite.compositeKey;
	}
	return makePluginKey(`${member.id}#${ordinal}`);
};

/** Walk the member tuple and emit one named-member entry per node,
 *  expanding composites' `innerParticipants` inline. */
const expand = (members: ReadonlyArray<AnyPlugin>): ReadonlyArray<NamedMember> => {
	const out: NamedMember[] = [];
	let ordinal = 0;
	for (const member of members) {
		const key = mintKey(member, ordinal++);
		out.push({ key, member, compositeParent: null });
		const composite = readStaticCapabilities(member).find(isCompositePrimitiveDecl);
		if (composite !== undefined) {
			for (const inner of composite.innerParticipants) {
				out.push({
					key: makePluginKey(`${key}/inner/${inner.id}#${ordinal++}`),
					member: inner,
					compositeParent: key,
				});
			}
		}
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
 *  1. Expand composites — their `innerParticipants` become first-class
 *     nodes with a `compositeParent` link.
 *  2. Build the resource-id → key index (providers).
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

		// Provider index: resource-id → key. Last writer wins; the
		// compile-time `MissingProviders` check ensures uniqueness on
		// the user-typed path, so a duplicate here would be a programmer
		// error in a runtime-typed composite — we don't enforce uniqueness
		// at runtime; the duplicate just resolves to the latest declaration.
		const providerByResourceId = new Map<string, PluginKey>();
		for (const { key, member } of named) {
			providerByResourceId.set(member.id, key);
		}

		const nodes = new Map<PluginKey, DepNode>();
		const indegree = new Map<PluginKey, number>();
		const downstream = new Map<PluginKey, Set<PluginKey>>();
		for (const { key } of named) {
			indegree.set(key, 0);
			downstream.set(key, new Set());
		}

		for (const { key, member, compositeParent } of named) {
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
			// Composite inner participants gain an implicit edge from the
			// composite parent — the supervisor must acquire the parent's
			// row first so the row exists in the projection.
			if (compositeParent !== null) {
				downstream.get(compositeParent)?.add(key);
				indegree.set(key, (indegree.get(key) ?? 0) + 1);
			}
			nodes.set(key, {
				key,
				member,
				compositeParent,
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
 *   "Invalidating a composite invalidates its children. Invalidating a
 *   producer invalidates downstream consumers along dep-graph edges
 *   (cascade semantics)."
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
	// Composite parents always propagate to their inner participants.
	for (const key of [...closure]) {
		for (const [innerKey, node] of graph.nodes) {
			if (node.compositeParent === key) closure.add(innerKey);
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
