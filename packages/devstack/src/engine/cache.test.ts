// `withCache(spec)` unit tests. Pins the contract callers depend on:
//
//   - hit  + verify-success  → return cached, no produce
//   - hit  + verify-undefined → evict + produce, persist result
//   - miss                    → produce, persist result
//   - cache key shape         → namespace/chainId/inputsHash
//   - chain-independent       → namespace/inputsHash when chainId is ''
//   - inputs-hash determinism → equal inputs produce equal keys
//   - inputs-hash sensitivity → different inputs produce different keys
//
// Tests use a hand-rolled `StateStore` Layer that captures every
// get/put/remove call so we can assert on the cache discipline directly
// without spinning up a file-backed StateStore.

import { Context, Effect, Layer, Option, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { StateStore } from './state-store.js';
import { buildCacheKey, withCache } from './cache.js';

// Hand-rolled in-memory state store. Records every op into a Ref so
// tests can assert call shape (number of produces, eviction sequence,
// etc.) in addition to the final cache state.
const makeFakeStateStore = () =>
	Effect.gen(function* () {
		const store = yield* Ref.make<Map<string, unknown>>(new Map());
		const ops = yield* Ref.make<Array<string>>([]);
		const layer = Layer.succeed(StateStore, {
			get: <T>(key: string) =>
				Ref.update(ops, (xs) => [...xs, `get(${key})`]).pipe(
					Effect.flatMap(() => Ref.get(store)),
					Effect.map((m) => (m.has(key) ? Option.some(m.get(key) as T) : Option.none<T>())),
				),
			put: <T>(key: string, value: T) =>
				Ref.update(ops, (xs) => [...xs, `put(${key})`]).pipe(
					Effect.andThen(Ref.update(store, (m) => new Map(m).set(key, value))),
				),
			remove: (key: string) =>
				Ref.update(ops, (xs) => [...xs, `remove(${key})`]).pipe(
					Effect.andThen(
						Ref.update(store, (m) => {
							const next = new Map(m);
							next.delete(key);
							return next;
						}),
					),
				),
		});
		return { layer, store, ops };
	});

describe('buildCacheKey', () => {
	it('includes chainId in the middle slot when non-empty', () => {
		expect(buildCacheKey({ namespace: 'foo/v1', chainId: 'abc', inputsHash: 'deadbeef' })).toBe(
			'foo/v1/abc/deadbeef',
		);
	});

	it('omits chainId when empty (chain-independent caches)', () => {
		expect(buildCacheKey({ namespace: 'foo/v1', chainId: '', inputsHash: 'deadbeef' })).toBe(
			'foo/v1/deadbeef',
		);
	});
});

describe('withCache', () => {
	it.effect('cache miss → produce + put + return', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			const result = yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: () => Effect.succeed(undefined as undefined),
				produce: Effect.succeed({ value: 42 }),
			}).pipe(Effect.provide(fake.layer));
			expect(result).toEqual({ value: 42 });
			const ops = yield* Ref.get(fake.ops);
			// Expect get → put. No remove (no prior entry to evict).
			expect(ops).toHaveLength(2);
			expect(ops[0]).toMatch(/^get\(test\/v1\/chain-a\//);
			expect(ops[1]).toMatch(/^put\(test\/v1\/chain-a\//);
		}),
	);

	it.effect('cache hit + verify-success → no produce, no put', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			// Pre-seed the cache.
			const spec = {
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (cached: { value: number }) => Effect.succeed(cached),
				produce: Effect.die('produce must not be called'),
			};
			// Run once to seed.
			yield* withCache({
				...spec,
				produce: Effect.succeed({ value: 7 }),
			}).pipe(Effect.provide(fake.layer));
			yield* Ref.set(fake.ops, []);
			// Now run with a producer that would fail if invoked.
			const result = yield* withCache(spec).pipe(Effect.provide(fake.layer));
			expect(result).toEqual({ value: 7 });
			const ops = yield* Ref.get(fake.ops);
			expect(ops).toHaveLength(1);
			expect(ops[0]).toMatch(/^get\(/);
		}),
	);

	it.effect('cache hit + verify-undefined → evict + produce + put', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			// Seed with `{ value: 1 }`.
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (cached: { value: number }) => Effect.succeed(cached),
				produce: Effect.succeed({ value: 1 }),
			}).pipe(Effect.provide(fake.layer));
			yield* Ref.set(fake.ops, []);
			// Verify says "invalid" → produce should re-run and return
			// the fresh value.
			const result = yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (_cached: { value: number }) => Effect.succeed(undefined as undefined),
				produce: Effect.succeed({ value: 99 }),
			}).pipe(Effect.provide(fake.layer));
			expect(result).toEqual({ value: 99 });
			const ops = yield* Ref.get(fake.ops);
			// get → remove (eviction) → put (fresh value).
			expect(ops).toHaveLength(3);
			expect(ops[0]).toMatch(/^get\(/);
			expect(ops[1]).toMatch(/^remove\(/);
			expect(ops[2]).toMatch(/^put\(/);
		}),
	);

	it.effect('different inputs produce different cache keys', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (c: number) => Effect.succeed(c),
				produce: Effect.succeed(1),
			}).pipe(Effect.provide(fake.layer));
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 2 }),
				verify: (c: number) => Effect.succeed(c),
				produce: Effect.succeed(2),
			}).pipe(Effect.provide(fake.layer));
			const ops = yield* Ref.get(fake.ops);
			// Each call: get + put → 4 ops total, 2 unique keys (x=1 vs x=2).
			const keys = ops.map((o) => o.replace(/^[a-z]+\(([^)]*)\)$/, '$1'));
			expect(new Set(keys).size).toBe(2);
		}),
	);

	it.effect('chainId is part of the cache key', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			// Same inputs, different chainId → two entries.
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (c: number) => Effect.succeed(c),
				produce: Effect.succeed(1),
			}).pipe(Effect.provide(fake.layer));
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-b',
				inputs: Effect.succeed({ x: 1 }),
				verify: (c: number) => Effect.succeed(c),
				produce: Effect.succeed(2),
			}).pipe(Effect.provide(fake.layer));
			const ops = yield* Ref.get(fake.ops);
			const puts = ops.filter((o) => o.startsWith('put('));
			expect(puts).toHaveLength(2);
			expect(puts[0]).not.toBe(puts[1]);
			expect(puts[0]).toContain('chain-a');
			expect(puts[1]).toContain('chain-b');
		}),
	);

	it.effect('verify can read services from the runtime', () =>
		Effect.gen(function* () {
			// Build a `verify` that depends on a fake probe service so we
			// pin that `RVerify` flows through the helper's signature.
			class ChainProbe extends Context.Service<
				ChainProbe,
				{ readonly check: Effect.Effect<boolean> }
			>()('@test/ChainProbe') {}
			const fake = yield* makeFakeStateStore();
			// Seed.
			yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (c: number) => Effect.succeed(c),
				produce: Effect.succeed(1),
			}).pipe(Effect.provide(fake.layer));
			// Verify says invalid because probe returns false.
			const result = yield* withCache({
				namespace: 'test/v1',
				chainId: 'chain-a',
				inputs: Effect.succeed({ x: 1 }),
				verify: (cached: number) =>
					Effect.gen(function* () {
						const probe = yield* ChainProbe;
						const ok = yield* probe.check;
						return ok ? cached : undefined;
					}),
				produce: Effect.succeed(2),
			}).pipe(
				Effect.provide(fake.layer),
				Effect.provide(Layer.succeed(ChainProbe, { check: Effect.succeed(false) })),
			);
			expect(result).toBe(2);
		}),
	);
});
