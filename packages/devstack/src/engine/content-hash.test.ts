// `contentHash` is the cache-key derivation for image tags, config
// fingerprints, and the supervisor's file-watcher short-circuit. A
// regression here silently busts every downstream cache, or worse —
// makes two distinct inputs map to the same key.

import { describe, expect, it } from '@effect/vitest';
import { createHash } from 'node:crypto';
import { contentHash, createContentHasher, digestHex, truncateDigest } from './content-hash.js';

describe('contentHash', () => {
	it('hashes a string as UTF-8 bytes and returns the full hex digest by default', () => {
		const expected = createHash('sha256').update('hello').digest('hex');
		expect(contentHash('hello')).toBe(expected);
		expect(expected.length).toBe(64);
	});

	it('truncates to `options.length` chars', () => {
		const full = contentHash('hello');
		expect(contentHash('hello', { length: 12 })).toBe(full.slice(0, 12));
		expect(contentHash('hello', { length: 16 })).toBe(full.slice(0, 16));
		expect(contentHash('hello', { length: 64 })).toBe(full);
	});

	it('hashes a Uint8Array verbatim (no UTF-8 round-trip)', () => {
		const bytes = new Uint8Array([0, 1, 2, 255, 128]);
		const expected = createHash('sha256').update(bytes).digest('hex');
		expect(contentHash(bytes)).toBe(expected);
	});

	it('hashes an object via JSON.stringify', () => {
		const obj = { a: 1, b: 'two', c: [3, 4] };
		const expected = createHash('sha256').update(JSON.stringify(obj)).digest('hex');
		expect(contentHash(obj)).toBe(expected);
	});

	it('does NOT canonicalize object key order — caller is responsible', () => {
		// Documents the contract: callers that need order-stability MUST
		// sort/normalize the input themselves before passing in.
		const a = { x: 1, y: 2 };
		const b = { y: 2, x: 1 };
		// JS engines preserve insertion order in JSON.stringify, so these
		// two objects with different insertion orders produce different
		// digests. The helper does NOT paper over that.
		expect(contentHash(a)).not.toBe(contentHash(b));
	});

	it('distinct inputs map to distinct digests (collision-resistance smoke)', () => {
		expect(contentHash('foo')).not.toBe(contentHash('bar'));
		expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
		expect(contentHash(new Uint8Array([0]))).not.toBe(contentHash(new Uint8Array([1])));
	});

	it('matches the open-coded `createHash(...).digest().slice(0, N)` form', () => {
		// The whole point of the helper: replace open-coded sites without
		// changing any caller's digest. Pin the equivalence directly.
		const input = JSON.stringify({ x: 1 });
		const open = createHash('sha256').update(input).digest('hex').slice(0, 16);
		expect(contentHash({ x: 1 }, { length: 16 })).toBe(open);
	});
});

describe('createContentHasher / digestHex', () => {
	it('streams multiple `.update(...)` calls into a single digest', () => {
		const h1 = createContentHasher();
		h1.update('a\0');
		h1.update('b\0');
		const streamed = digestHex(h1);
		const oneshot = createHash('sha256').update('a\0').update('b\0').digest('hex');
		expect(streamed).toBe(oneshot);
	});

	it('digestHex truncates via the same `length` knob as contentHash', () => {
		const h = createContentHasher();
		h.update('payload');
		const full = digestHex(h);
		expect(full.length).toBe(64);
		const h2 = createContentHasher();
		h2.update('payload');
		expect(digestHex(h2, { length: 12 })).toBe(full.slice(0, 12));
	});

	it('digestHex without `length` returns the full hex digest', () => {
		const h = createContentHasher();
		h.update('x');
		expect(digestHex(h)).toBe(createHash('sha256').update('x').digest('hex'));
	});
});

describe('truncateDigest', () => {
	it('slices a hex digest to `length` chars', () => {
		const hex = createHash('sha256').update('abc').digest('hex');
		expect(truncateDigest(hex, 12)).toBe(hex.slice(0, 12));
		expect(truncateDigest(hex, 64)).toBe(hex);
	});
});
