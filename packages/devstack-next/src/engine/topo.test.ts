import { describe, expect, it } from 'vitest';

import { buildDownstreamIndex, CycleError, topoSort } from './topo.js';

const sym = (name: string): symbol => Symbol(name);

describe('topoSort', () => {
	it('orders linear chain upstream-first', () => {
		const a = sym('a');
		const b = sym('b');
		const c = sym('c');
		const edges = new Map<symbol, symbol[]>([
			[a, [b]],
			[b, [c]],
			[c, []],
		]);
		const order = topoSort({
			ids: [a, b, c],
			upstreamOf: (id) => edges.get(id) ?? [],
		});
		expect(order.indexOf(c)).toBeLessThan(order.indexOf(b));
		expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));
	});

	it('orders diamond with both branches before sink', () => {
		const a = sym('a');
		const b = sym('b');
		const c = sym('c');
		const d = sym('d');
		// d depends on b and c; b and c each depend on a.
		const edges = new Map<symbol, symbol[]>([
			[d, [b, c]],
			[b, [a]],
			[c, [a]],
			[a, []],
		]);
		const order = topoSort({
			ids: [d, b, c, a],
			upstreamOf: (id) => edges.get(id) ?? [],
		});
		expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
		expect(order.indexOf(a)).toBeLessThan(order.indexOf(c));
		expect(order.indexOf(b)).toBeLessThan(order.indexOf(d));
		expect(order.indexOf(c)).toBeLessThan(order.indexOf(d));
	});

	it('throws CycleError with the cycle path', () => {
		const a = sym('a');
		const b = sym('b');
		const c = sym('c');
		const edges = new Map<symbol, symbol[]>([
			[a, [b]],
			[b, [c]],
			[c, [a]],
		]);
		expect(() =>
			topoSort({
				ids: [a, b, c],
				upstreamOf: (id) => edges.get(id) ?? [],
			}),
		).toThrow(CycleError);
	});

	it('handles empty graph', () => {
		expect(topoSort({ ids: [], upstreamOf: () => [] })).toEqual([]);
	});
});

describe('buildDownstreamIndex', () => {
	it('returns transitive downstream for linear chain', () => {
		const a = sym('a');
		const b = sym('b');
		const c = sym('c');
		// a → b → c (c depends on b depends on a)
		const edges = new Map<symbol, symbol[]>([
			[c, [b]],
			[b, [a]],
			[a, []],
		]);
		const index = buildDownstreamIndex({
			ids: [a, b, c],
			upstreamOf: (id) => edges.get(id) ?? [],
		});
		expect(index.get(a)).toEqual(new Set([b, c]));
		expect(index.get(b)).toEqual(new Set([c]));
		expect(index.get(c)).toEqual(new Set());
	});

	it('returns transitive downstream for diamond', () => {
		const a = sym('a');
		const b = sym('b');
		const c = sym('c');
		const d = sym('d');
		const edges = new Map<symbol, symbol[]>([
			[d, [b, c]],
			[b, [a]],
			[c, [a]],
		]);
		const index = buildDownstreamIndex({
			ids: [a, b, c, d],
			upstreamOf: (id) => edges.get(id) ?? [],
		});
		expect(index.get(a)).toEqual(new Set([b, c, d]));
	});
});
