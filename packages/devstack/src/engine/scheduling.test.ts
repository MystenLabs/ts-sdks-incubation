import { describe, expect, it } from 'vitest';
import { colorByLockKeys, decomposeRanks } from './scheduling.js';

// Deterministic RNG for reproducible random graph tests. Mulberry32.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('decomposeRanks', () => {
	it('returns rank 0 for nodes with no upstream', () => {
		const ranks = decomposeRanks(['a', 'b', 'c'], () => []);
		expect(ranks.get('a')).toBe(0);
		expect(ranks.get('b')).toBe(0);
		expect(ranks.get('c')).toBe(0);
	});

	it('chains a→b→c into ranks 0, 1, 2', () => {
		const ranks = decomposeRanks(['a', 'b', 'c'], (id) => {
			if (id === 'b') return ['a'];
			if (id === 'c') return ['b'];
			return [];
		});
		expect(ranks.get('a')).toBe(0);
		expect(ranks.get('b')).toBe(1);
		expect(ranks.get('c')).toBe(2);
	});

	it('rank is max(rank of upstream) + 1 across diamonds', () => {
		// a → b, a → c, b → d, c → d  (diamond)
		const upstream = (id: string): string[] => {
			if (id === 'b' || id === 'c') return ['a'];
			if (id === 'd') return ['b', 'c'];
			return [];
		};
		const ranks = decomposeRanks(['a', 'b', 'c', 'd'], upstream);
		expect(ranks.get('a')).toBe(0);
		expect(ranks.get('b')).toBe(1);
		expect(ranks.get('c')).toBe(1);
		expect(ranks.get('d')).toBe(2);
	});

	it('siblings under different roots can share a rank', () => {
		const upstream = (id: string): string[] => {
			if (id === 'b') return ['a'];
			if (id === 'd') return ['c'];
			return [];
		};
		const ranks = decomposeRanks(['a', 'b', 'c', 'd'], upstream);
		expect(ranks.get('a')).toBe(0);
		expect(ranks.get('c')).toBe(0);
		expect(ranks.get('b')).toBe(1);
		expect(ranks.get('d')).toBe(1);
	});

	it('handles upstream nodes that appear later in input order', () => {
		// Upstream b is listed AFTER a in input — decompose must still
		// resolve a→b dep correctly.
		const upstream = (id: string): string[] => (id === 'a' ? ['b'] : []);
		const ranks = decomposeRanks(['a', 'b'], upstream);
		expect(ranks.get('a')).toBe(1);
		expect(ranks.get('b')).toBe(0);
	});

	it('every node ends up in some rank', () => {
		const rand = rng(42);
		const N = 50;
		const ids = Array.from({ length: N }, (_, i) => `n${i}`);
		// Build a DAG: each node depends on 0-2 strictly-lower-indexed nodes.
		const upstreamMap = new Map<string, string[]>();
		for (let i = 0; i < N; i++) {
			const count = i === 0 ? 0 : Math.floor(rand() * 3);
			const ups: string[] = [];
			for (let k = 0; k < count && i > 0; k++) {
				ups.push(`n${Math.floor(rand() * i)}`);
			}
			upstreamMap.set(`n${i}`, [...new Set(ups)]);
		}
		const ranks = decomposeRanks(ids, (id) => upstreamMap.get(id) ?? []);
		for (const id of ids) expect(ranks.has(id)).toBe(true);
		// Invariant: rank(node) > rank(every upstream of node)
		for (const [id, ups] of upstreamMap) {
			for (const up of ups) {
				expect(ranks.get(id)!).toBeGreaterThan(ranks.get(up)!);
			}
		}
	});
});

describe('colorByLockKeys', () => {
	it('nodes with no lockKeys all share color 0 (free to parallelize)', () => {
		const colors = colorByLockKeys(['a', 'b', 'c'], () => new Set());
		expect(colors.get('a')).toBe(0);
		expect(colors.get('b')).toBe(0);
		expect(colors.get('c')).toBe(0);
	});

	it('nodes sharing one lockKey get distinct colors', () => {
		const colors = colorByLockKeys(['a', 'b'], () => new Set(['publisher']));
		expect(colors.get('a')).not.toBe(colors.get('b'));
	});

	it('three nodes sharing one lockKey occupy three distinct colors', () => {
		const colors = colorByLockKeys(['a', 'b', 'c'], () => new Set(['publisher']));
		const distinct = new Set([colors.get('a'), colors.get('b'), colors.get('c')]);
		expect(distinct.size).toBe(3);
	});

	it('nodes with disjoint lockKeys can share a color', () => {
		const lockKeys = (id: string): Set<string> =>
			id === 'a' ? new Set(['alice']) : new Set(['bob']);
		const colors = colorByLockKeys(['a', 'b'], lockKeys);
		// Disjoint keys → no conflict → both can be color 0.
		expect(colors.get('a')).toBe(colors.get('b'));
	});

	it('a node sharing keys with two disjoint nodes lands on color 2', () => {
		// a: {alice}, b: {bob}, c: {alice, bob} — c conflicts with a and b.
		// Greedy in name order: a→0, b→0 (disjoint), c→1.
		const lockKeys = (id: string): Set<string> =>
			id === 'a' ? new Set(['alice'])
				: id === 'b' ? new Set(['bob'])
					: new Set(['alice', 'bob']);
		const colors = colorByLockKeys(['a', 'b', 'c'], lockKeys);
		expect(colors.get('a')).toBe(0);
		expect(colors.get('b')).toBe(0);
		expect(colors.get('c')).toBe(1);
	});

	it('coloring is deterministic given stable input order', () => {
		const lockKeys = (id: string): Set<string> => new Set([id.charAt(0)]);
		const c1 = colorByLockKeys(['a1', 'a2', 'b1', 'b2'], lockKeys);
		const c2 = colorByLockKeys(['a1', 'a2', 'b1', 'b2'], lockKeys);
		for (const k of c1.keys()) expect(c1.get(k)).toBe(c2.get(k));
	});

	it('100 random conflict graphs: every color group has zero shared lockKeys (the invariant)', () => {
		const rand = rng(7);
		for (let trial = 0; trial < 100; trial++) {
			const N = 5 + Math.floor(rand() * 20);
			const KEYS = ['a', 'b', 'c', 'd', 'e'];
			const ids = Array.from({ length: N }, (_, i) => `n${i}`);
			const lockKeyMap = new Map<string, Set<string>>();
			for (const id of ids) {
				const keys = new Set<string>();
				const keyCount = Math.floor(rand() * 3);
				for (let k = 0; k < keyCount; k++) {
					keys.add(KEYS[Math.floor(rand() * KEYS.length)]!);
				}
				lockKeyMap.set(id, keys);
			}
			const colors = colorByLockKeys(ids, (id) => lockKeyMap.get(id) ?? new Set());

			// Group by color and verify no two nodes in the same group share a key.
			const byColor = new Map<number, string[]>();
			for (const [id, color] of colors) {
				const list = byColor.get(color) ?? [];
				list.push(id);
				byColor.set(color, list);
			}
			for (const [, group] of byColor) {
				for (let i = 0; i < group.length; i++) {
					for (let j = i + 1; j < group.length; j++) {
						const keysI = lockKeyMap.get(group[i]!) ?? new Set();
						const keysJ = lockKeyMap.get(group[j]!) ?? new Set();
						for (const k of keysI) {
							if (keysJ.has(k)) {
								throw new Error(
									`trial ${trial}: nodes ${group[i]} + ${group[j]} both in color ${colors.get(group[i]!)} share lockKey '${k}'`,
								);
							}
						}
					}
				}
			}
		}
	});
});
