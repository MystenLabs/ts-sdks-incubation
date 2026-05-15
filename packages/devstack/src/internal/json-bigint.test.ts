// BigInt JSON codec is the foundation of state-store persistence — a
// regression here silently corrupts every plugin's persisted state.

import { describe, expect, it } from '@effect/vitest';
import { jsonBigintReplacer, jsonBigintReviver } from './json-bigint.js';

const roundTrip = <T>(value: T): unknown =>
	JSON.parse(JSON.stringify(value, jsonBigintReplacer), jsonBigintReviver);

describe('json-bigint', () => {
	it('round-trips BigInts at edges (0, ±, MAX_SAFE_INTEGER, 2^64)', () => {
		expect(roundTrip(0n)).toBe(0n);
		expect(roundTrip(1n)).toBe(1n);
		expect(roundTrip(-1n)).toBe(-1n);
		expect(roundTrip(BigInt(Number.MAX_SAFE_INTEGER))).toBe(BigInt(Number.MAX_SAFE_INTEGER));
		// 2^64 exceeds Number precision — proves we're not silently downcasting.
		expect(roundTrip(1n << 64n)).toBe(1n << 64n);
		expect(roundTrip(-(1n << 64n))).toBe(-(1n << 64n));
	});

	it('round-trips plain JSON scalars and containers unchanged', () => {
		expect(roundTrip('hello')).toBe('hello');
		expect(roundTrip(42)).toBe(42);
		expect(roundTrip(null)).toBe(null);
		expect(roundTrip(true)).toBe(true);
		expect(roundTrip([1, 'a', null])).toEqual([1, 'a', null]);
		expect(roundTrip({ k: 'v' })).toEqual({ k: 'v' });
	});

	it('round-trips mixed payloads (BigInts nested in objects + arrays)', () => {
		const payload = {
			id: 'tx-1',
			amounts: [10n, 0n, -5n],
			meta: { gas: 1_000_000n, label: 'mint', flags: [true, false] },
			nested: { deep: { value: 9_223_372_036_854_775_807n } },
		};
		expect(roundTrip(payload)).toEqual(payload);
	});

	it('throws on invalid {__bigint: <non-numeric>} payloads (no silent swallow)', () => {
		// The reviver passes the tagged string straight to `BigInt(...)`,
		// which throws SyntaxError. We assert that surface here so a future
		// refactor that adds a try/catch doesn't introduce silent corruption.
		const raw = JSON.stringify({ __bigint: 'not-a-number' });
		expect(() => JSON.parse(raw, jsonBigintReviver)).toThrow(SyntaxError);
	});

	it('leaves look-alike tags untouched (only exact __bigint:string matches)', () => {
		expect(roundTrip({ __bigint_other: 'xyz' })).toEqual({ __bigint_other: 'xyz' });
		// Wrong type for the tag value — must not be coerced to BigInt.
		const raw = JSON.stringify({ __bigint: 42 });
		expect(JSON.parse(raw, jsonBigintReviver)).toEqual({ __bigint: 42 });
	});
});
