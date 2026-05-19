// Static dependency graph for selective per-primitive restart.
//
// What this module is
// ---
// A pure data-structure / graph-algorithm layer used by the supervisor
// to answer: "when watched path X fires, which set of primitives must
// re-acquire?" The answer is the owning primitive of X plus its
// transitive downstream consumers — every other primitive keeps its
// scope, its resources, and its TUI row state.
//
// Phase 1 of `notes/selective-restart.md`. Phase 2 wires the
// `DownstreamClosure` into per-primitive scopes; Phase 3 wires it into
// `engine.invalidateSubset`. This module does NOT mutate engine state,
// run any Effect, or open any scope — it's a synchronous compose-time
// pass that emits the static graph once per supervisor lifetime.
//
// Why not introspect `Layer.requirements`?
// ---
// Effect v4 Layer instances only expose a `build(memoMap, scope)`
// function at runtime — the `RIn` type parameter is type-level only.
// We can't enumerate the Context keys a Layer consumes without
// actually running the build's effect (which is what we're trying to
// avoid here). So the graph is derived from an explicit declaration
// each stack member carries: the optional `__upstreamKeys` field.
//
// Plugin-author primitives populated via `dependsOn:` (host-script,
// docker-one-shot) get this for free — their wrappers surface
// `dependsOn` as `__upstreamKeys`. Existing primitives that don't yet
// declare deps end up with an empty `upstreamKeys` set, which means
// they appear as leaves in the graph; selective restart still works
// (a watch-fire on their own `__watchPaths` invalidates just them),
// it just can't compute downstream cascades for them yet. Phase 2/3
// populate `__upstreamKeys` on the rest of the primitives.

import { Schema } from 'effect';

/**
 * One node in the static dependency graph — corresponds to a single
 * top-level stack member (a `LayeredTag` produced by `tag` / `provide` /
 * `composeLayers`).
 *
 * `key` is the tag identity (`'@devstack/SuiTag'`, `'publish.vault'`,
 * `'account/alice'`, etc.) — same string the engine uses to identify
 * a TUI row.
 *
 * `watchPaths` are the absolute paths the primitive declared via
 * `watch:` (positive includes only — `!`-negations are filtering rules,
 * not ownership claims). Empty for primitives that don't watch anything.
 *
 * `upstreamKeys` are the keys of other stack members this primitive
 * yields inside its build body — its direct (non-transitive) deps.
 * The graph builder treats this as data; correctness depends on the
 * declaring primitive populating it (or being annotated empty if its
 * deps aren't yet wired into the field).
 */
export interface PrimitiveNode {
	readonly key: string;
	readonly watchPaths: ReadonlyArray<string>;
	readonly upstreamKeys: ReadonlyArray<string>;
}

/**
 * The static dependency graph: one entry per top-level stack member,
 * keyed by tag identity. Read-only; built once at supervisor compose
 * time and threaded through to the watch fiber + engine.
 */
export type DepGraph = ReadonlyMap<string, PrimitiveNode>;

/**
 * For each primitive `K`, the transitive set of primitives that
 * (re-)acquire when `K` invalidates — STRICTLY DOWNSTREAM. The owner
 * `K` itself is NOT in the set; callers union `{K} ∪ closure.get(K)` to
 * build the full affected set (Phase 3's `engine.invalidateSubset`
 * call site does exactly this).
 *
 * Strictly-downstream semantics line up with the Phase-5 log-line
 * format `"(N downstream: <names>)"` — `N` is the count of TRANSITIVE
 * consumers, not "owner + consumers", so a single-primitive cascade
 * reads naturally as `"0 downstream"` rather than confusingly as
 * `"1 downstream: self"`.
 *
 * Built once per supervisor lifetime by reversing the upstream edges
 * in `DepGraph` and BFS'ing forward from each node. The graph is
 * static across cycles, so the closure is computed once.
 */
export type DownstreamClosure = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Minimum shape `buildDepGraph` reads off each stack member. The real
 * `StackMember` type in `supervisor.ts` carries more fields (the
 * `__layer` itself, `__kind`, `__displayTitle`, …); the graph builder
 * only needs the identity (`key`), the watch declaration
 * (`__watchPaths`), and the upstream declaration (`__upstreamKeys`).
 *
 * Members lacking `key` (hand-rolled layers) are skipped — without a
 * stable identity there's no way to attribute a scope to them.
 *
 * `__upstreamKeys` is the new field this phase introduces. Plugin-
 * author primitives that already accept a `dependsOn:` array surface
 * it transparently here; primitives that don't declare deps yet
 * appear as leaves (empty `upstreamKeys`). Phase 2 / 3 populate it
 * on the rest of the in-tree primitives.
 */
export interface DepGraphMember {
	readonly key?: string;
	readonly __watchPaths?: ReadonlyArray<string>;
	readonly __upstreamKeys?: ReadonlyArray<string>;
}

/**
 * Reason a `buildDepGraph` call failed. The cycle case is the only
 * surface where the graph is structurally invalid; everything else is
 * tolerated (missing keys are skipped, unknown upstream references are
 * dropped with a warning so a stale annotation doesn't tear the supervisor
 * down).
 *
 * Hard-fail policy per `notes/selective-restart.md` §"Decisions baked
 * into this plan": "Dep-graph failure is a hard error. No fallback to
 * the old full-restart loop."
 */
export class DepGraphError extends Schema.TaggedErrorClass<DepGraphError>('DepGraphError')(
	'@devstack/DepGraphError',
	{
		phase: Schema.Literals(['cycle']),
		message: Schema.String,
		/** Keys forming the cycle, in traversal order. Empty when not applicable. */
		cycle: Schema.Array(Schema.String),
	},
) {}

/**
 * Build the static dep graph for a list of stack members. Pure /
 * synchronous — runs once per supervisor lifetime at compose time.
 *
 * Members lacking a `key` (e.g. hand-rolled Layer escape hatches) are
 * skipped silently — without an identity they can't participate in a
 * scope-keyed graph. Members with a `key` that's already present (a
 * duplicate) keep the first occurrence; duplicate detection itself is
 * `composeStackLayer`'s job (it console.warns).
 *
 * Upstream references to keys not present in the stack are dropped
 * (filtered out of `upstreamKeys`) — this is a "stale annotation"
 * surface that shouldn't tear down the supervisor: a primitive might
 * declare `dependsOn` against a tag that isn't in this particular
 * stack composition.
 *
 * Throws `DepGraphError({phase: 'cycle'})` when the upstream edges
 * form a cycle (one primitive ultimately depending on itself). In
 * practice cycles are structurally rare — Effect's `Layer.provideMerge`
 * fold requires providers-before-consumers ordering, which already
 * means upstream-cycle is rejected at compose time by `Layer.mergeAll`'s
 * service-not-found check. But the `__upstreamKeys` declaration is
 * data, so a typo'd annotation could spell a cycle; we detect and
 * fail hard rather than infinite-loop the closure walk.
 */
export const buildDepGraph = (stack: ReadonlyArray<DepGraphMember>): DepGraph => {
	// First pass: enumerate keys we know about so we can filter
	// dangling upstream references.
	const knownKeys = new Set<string>();
	for (const m of stack) {
		if (m.key !== undefined) knownKeys.add(m.key);
	}

	const nodes = new Map<string, PrimitiveNode>();
	for (const m of stack) {
		if (m.key === undefined) continue;
		if (nodes.has(m.key)) continue; // First occurrence wins (matches `composeStackLayer`'s duplicate-key handling).
		// Positive includes only — `!`-negations are filtering rules,
		// not ownership claims, so they don't surface as watch-owned
		// paths. Mirrors `supervisor.ts::watchOwners`'s filter.
		const watchPaths = (m.__watchPaths ?? []).filter((p) => !p.startsWith('!'));
		const upstreamKeys = (m.__upstreamKeys ?? []).filter((k) => knownKeys.has(k));
		nodes.set(m.key, { key: m.key, watchPaths, upstreamKeys });
	}

	// Cycle detection via DFS coloring. Three colors: 0 = unvisited,
	// 1 = on the current path (gray), 2 = fully explored (black). A
	// gray-to-gray edge means we just closed a cycle.
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const key of nodes.keys()) color.set(key, WHITE);

	const cyclePath: string[] = [];
	const dfs = (key: string): boolean => {
		color.set(key, GRAY);
		cyclePath.push(key);
		const node = nodes.get(key);
		if (node !== undefined) {
			for (const up of node.upstreamKeys) {
				const upColor = color.get(up) ?? WHITE;
				if (upColor === GRAY) {
					// Trim the prefix not in the cycle so the reported path
					// starts at the back-edge's destination.
					const cycleStart = cyclePath.indexOf(up);
					cyclePath.splice(0, cycleStart);
					cyclePath.push(up);
					return true;
				}
				if (upColor === WHITE && dfs(up)) return true;
			}
		}
		color.set(key, BLACK);
		cyclePath.pop();
		return false;
	};
	for (const key of nodes.keys()) {
		if ((color.get(key) ?? WHITE) !== WHITE) continue;
		if (dfs(key)) {
			throw new DepGraphError({
				phase: 'cycle',
				message: `Dep graph contains a cycle: ${cyclePath.join(' → ')}`,
				cycle: cyclePath,
			});
		}
	}

	return nodes;
};

/**
 * Compute the downstream-closure map for a dep graph: for each node
 * `K`, the set of transitive consumers of `K` — `K` itself is NOT
 * included (see {@link DownstreamClosure}).
 *
 * Implementation: reverse the upstream edges to build a forward
 * consumer-index, then BFS forward from each node. Built once per
 * supervisor lifetime; the graph is static across cycles.
 *
 * Callers union `{ownerKey} ∪ closure.get(ownerKey)` to build the
 * full affected set passed to `engine.invalidateSubset`.
 */
export const computeDownstreamClosure = (graph: DepGraph): DownstreamClosure => {
	// Reverse edges: consumers[K] = {nodes that yield K}.
	const consumers = new Map<string, Set<string>>();
	for (const key of graph.keys()) consumers.set(key, new Set<string>());
	for (const [consumer, node] of graph) {
		for (const upstream of node.upstreamKeys) {
			// Upstream filtering already happened in `buildDepGraph` —
			// dangling references were dropped — but defend against a
			// caller passing a hand-constructed graph that bypassed
			// `buildDepGraph`.
			const set = consumers.get(upstream);
			if (set !== undefined) set.add(consumer);
		}
	}

	const closure = new Map<string, ReadonlySet<string>>();
	for (const start of graph.keys()) {
		// BFS forward from `start`. `start` seeds the visited set so it
		// short-circuits a re-traversal back through a cycle-free
		// upstream loop, but is removed before publishing so the closure
		// is STRICTLY-DOWNSTREAM.
		const visited = new Set<string>([start]);
		const queue: string[] = [start];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			const downstream = consumers.get(cur);
			if (downstream === undefined) continue;
			for (const next of downstream) {
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(next);
			}
		}
		visited.delete(start);
		closure.set(start, visited);
	}
	return closure;
};

/**
 * Convenience: the strictly-downstream set for an owner key. Returns
 * an empty set when the owner isn't in the graph (caller should treat
 * that as "no owner attribution found" rather than a hard error —
 * the watch fiber already logs "(unowned)" for paths that don't
 * resolve to a primitive). The owner key is NOT included in the
 * returned set; callers union `{ownerKey} ∪ reachableConsumers(...)`
 * to build the full affected set passed to
 * `engine.invalidateSubset`.
 */
export const reachableConsumers = (
	closure: DownstreamClosure,
	ownerKey: string,
): ReadonlySet<string> => closure.get(ownerKey) ?? new Set<string>();

/**
 * Group dep-graph nodes into topological levels: level 0 holds every
 * node with no upstream edges (leaves); level N holds every node whose
 * upstream set is fully contained in levels < N. The Phase B
 * scheduler folds these into `Layer.provideMerge(Layer.mergeAll(level), acc)`
 * so siblings in the same level build in parallel and each level's
 * outputs are visible to subsequent levels.
 *
 * Properties:
 *   - **Stable order within a level**: members keep their input-stack
 *     order, so the supervisor's "first declared wins" duplicate-key
 *     semantics + TUI seed ordering survive the level grouping.
 *   - **Pure / synchronous**: same shape as `buildDepGraph` /
 *     `computeDownstreamClosure`; runs once at compose time.
 *   - **No cycle handling**: callers feed the result of `buildDepGraph`,
 *     which already throws `DepGraphError({phase: 'cycle'})` on a
 *     cyclic upstream set. The Kahn-style level emission below assumes
 *     a DAG; a cycle would leave nodes unscheduled and silently drop
 *     them, so we assert by construction (the upstream graph is
 *     acyclic).
 *
 * Returns the levels in build order: level 0 first. Empty graph
 * returns an empty array. Order-of-emission within a level mirrors the
 * order keys were inserted into the graph (which itself mirrors the
 * stack member order).
 */
export const topoLevels = (graph: DepGraph): ReadonlyArray<ReadonlyArray<string>> => {
	// Track the unscheduled count of upstream edges per node. As we
	// emit a level, we decrement the count for every node that depended
	// on a now-scheduled key.
	const remainingUpstream = new Map<string, number>();
	const order: string[] = []; // input order, used to stabilise per-level emission.
	for (const [key, node] of graph) {
		remainingUpstream.set(key, node.upstreamKeys.length);
		order.push(key);
	}

	// Reverse-index: consumers[K] = nodes that list K as an upstream.
	const consumers = new Map<string, Array<string>>();
	for (const key of graph.keys()) consumers.set(key, []);
	for (const [consumer, node] of graph) {
		for (const upstream of node.upstreamKeys) {
			const arr = consumers.get(upstream);
			if (arr !== undefined) arr.push(consumer);
		}
	}

	const scheduled = new Set<string>();
	const levels: Array<ReadonlyArray<string>> = [];
	while (scheduled.size < graph.size) {
		const level: string[] = [];
		// Emit in input order so two parallel-eligible siblings render
		// in the order the user wrote them — keeps the TUI predictable.
		for (const key of order) {
			if (scheduled.has(key)) continue;
			if ((remainingUpstream.get(key) ?? 0) === 0) {
				level.push(key);
			}
		}
		if (level.length === 0) {
			// All remaining nodes still have unresolved upstreams — a
			// cycle slipped past `buildDepGraph` (shouldn't happen; that
			// function throws on cycles). Bail rather than infinite-loop.
			break;
		}
		for (const key of level) {
			scheduled.add(key);
			for (const consumer of consumers.get(key) ?? []) {
				remainingUpstream.set(consumer, (remainingUpstream.get(consumer) ?? 1) - 1);
			}
		}
		levels.push(level);
	}
	return levels;
};
