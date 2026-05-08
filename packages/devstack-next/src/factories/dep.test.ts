import { describe, expect, it } from 'vitest';
import { dep } from './dep.js';

describe('dep', () => {
	it('returns a recipe wrapping the get fn', () => {
		const recipe = dep((s: { count: number }) => s.count);
		expect(recipe.get({ count: 7 })).toBe(7);
	});

	it('passes state and data through to the projection fn', () => {
		const recipe = dep(
			(s: { map: Record<string, number> }, d: { key: string }) => s.map[d.key] ?? 0,
		);
		expect(recipe.get({ map: { a: 1, b: 2 } }, { key: 'b' })).toBe(2);
		expect(recipe.get({ map: { a: 1 } }, { key: 'missing' })).toBe(0);
	});

	it('preserves consumer-view inference', () => {
		const recipe = dep((s: { name: string }) => ({ tag: s.name.toUpperCase() }));
		// recipe.get's return type is { tag: string } — verify at runtime.
		expect(recipe.get({ name: 'sui' })).toEqual({ tag: 'SUI' });
	});
});
