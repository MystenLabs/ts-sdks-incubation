import { describe, expect, it } from 'vitest';
import { stableHash } from './hash.js';

describe('stableHash', () => {
	it('object key order does not affect the hash', () => {
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
	});

	it('drops undefined entries', () => {
		expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
	});

	it('hashes bigints distinctly from same-value numbers', () => {
		expect(stableHash(1n)).not.toBe(stableHash(1));
	});

	it('Date instances do not collide with empty object', () => {
		expect(stableHash(new Date('2024-01-01T00:00:00Z'))).not.toBe(stableHash({}));
	});

	it('Date instances of different ISO values produce different hashes', () => {
		expect(stableHash(new Date('2024-01-01'))).not.toBe(stableHash(new Date('2024-01-02')));
	});

	it('Map does not collide with empty object', () => {
		expect(stableHash(new Map([['a', 1]]))).not.toBe(stableHash({}));
	});

	it('Map ordering does not affect the hash', () => {
		const m1 = new Map<string, number>();
		m1.set('a', 1);
		m1.set('b', 2);
		const m2 = new Map<string, number>();
		m2.set('b', 2);
		m2.set('a', 1);
		expect(stableHash(m1)).toBe(stableHash(m2));
	});

	it('Set does not collide with empty object', () => {
		expect(stableHash(new Set(['a']))).not.toBe(stableHash({}));
	});

	it('Set ordering does not affect the hash', () => {
		expect(stableHash(new Set(['a', 'b']))).toBe(stableHash(new Set(['b', 'a'])));
	});

	it('RegExp does not collide with empty object', () => {
		expect(stableHash(/foo/)).not.toBe(stableHash({}));
	});

	it('RegExp source and flags both contribute to the hash', () => {
		expect(stableHash(/foo/g)).not.toBe(stableHash(/foo/i));
		expect(stableHash(/foo/)).not.toBe(stableHash(/bar/));
	});

	it('Date / Map / Set / RegExp do not all collide with each other', () => {
		const hashes = new Set([
			stableHash(new Date('2024-01-01')),
			stableHash(new Map<string, number>()),
			stableHash(new Set<string>()),
			stableHash(/x/),
			stableHash({}),
		]);
		expect(hashes.size).toBe(5);
	});

	it('does not stack-overflow on a self-referential object', () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(() => stableHash(a)).not.toThrow();
	});

	it('does not stack-overflow on a cyclic array', () => {
		const arr: unknown[] = [];
		arr.push(arr);
		expect(() => stableHash(arr)).not.toThrow();
	});

	it('produces stable output for nested structures with shared subobjects (no false cycle hit)', () => {
		const shared = { x: 1 };
		const v = { a: shared, b: shared };
		// Reading the value twice should produce the same hash.
		expect(stableHash(v)).toBe(stableHash(v));
		// And the value should not collide with a same-shape object that
		// puts the shared piece in only one slot.
		expect(stableHash(v)).not.toBe(stableHash({ a: shared }));
	});
});
