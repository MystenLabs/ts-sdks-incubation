// Pure scheduling primitives for the engine's parallel-cycle path.
// No engine imports — these are functions on opaque ids + closures.
//
// `decomposeRanks` levels a topologically-sorted DAG: rank(node) = 1 +
// max(rank(upstream)). Siblings under different roots may share a rank
// without depending on each other.
//
// `colorByLockKeys` runs greedy conflict-graph coloring within a single
// rank: two nodes that share any lockKey conflict; conflicting nodes
// must land on different colors. Within one color, nodes have pairwise-
// disjoint lockKeys, so they're safe to execute in parallel. Across
// colors within a rank, execution is sequential.
//
// Greedy in input-order coloring is stable: identical inputs produce
// identical color assignments. That's what makes the engine's
// observable behavior reproducible across runs.

/**
 * Assign every id to a rank such that rank(node) > rank(every upstream).
 * Ids may appear in any order; upstream resolution is deferred to
 * `upstreamOf`. Assumes the DAG has no cycles (callers run `topoSort`
 * first for the cycle check).
 */
export function decomposeRanks<TId>(
	ids: Iterable<TId>,
	upstreamOf: (id: TId) => Iterable<TId>,
): Map<TId, number> {
	const ranks = new Map<TId, number>();
	const visiting = new Set<TId>();

	const rankOf = (id: TId): number => {
		const cached = ranks.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) {
			// Cycle — topoSort should have caught this before us. If a
			// caller hands us a cyclic graph anyway, break the recursion
			// with rank 0 rather than stack-overflowing.
			return 0;
		}
		visiting.add(id);
		let maxUp = -1;
		for (const up of upstreamOf(id)) {
			const r = rankOf(up);
			if (r > maxUp) maxUp = r;
		}
		visiting.delete(id);
		const rank = maxUp + 1;
		ranks.set(id, rank);
		return rank;
	};

	for (const id of ids) rankOf(id);
	return ranks;
}

/**
 * Greedy conflict-graph coloring. Two ids conflict iff their lockKey
 * sets intersect. The returned color number is the lowest non-negative
 * integer that doesn't collide with any conflicting id's color.
 *
 * Nodes with empty lockKey sets never conflict with anyone — they all
 * land on color 0 (i.e., parallelizable with everything).
 *
 * Iteration follows the order of `ids`; passing a stable order produces
 * a stable coloring across runs.
 */
export function colorByLockKeys<TId>(
	ids: Iterable<TId>,
	lockKeysOf: (id: TId) => ReadonlySet<string>,
): Map<TId, number> {
	const colors = new Map<TId, number>();
	// Track which colors are forbidden for the current id, derived
	// from the lockKey overlaps with already-colored ids.
	const order: TId[] = [];
	const lockKeysMemo = new Map<TId, ReadonlySet<string>>();
	for (const id of ids) {
		order.push(id);
		lockKeysMemo.set(id, lockKeysOf(id));
	}

	for (const id of order) {
		const myKeys = lockKeysMemo.get(id)!;
		if (myKeys.size === 0) {
			colors.set(id, 0);
			continue;
		}
		const forbidden = new Set<number>();
		for (const other of order) {
			if (other === id) continue;
			const otherColor = colors.get(other);
			if (otherColor === undefined) continue;
			const otherKeys = lockKeysMemo.get(other)!;
			if (sharesAnyKey(myKeys, otherKeys)) forbidden.add(otherColor);
		}
		let color = 0;
		while (forbidden.has(color)) color += 1;
		colors.set(id, color);
	}

	return colors;
}

function sharesAnyKey(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	// Iterate the smaller set for the membership probe.
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const k of small) if (large.has(k)) return true;
	return false;
}
