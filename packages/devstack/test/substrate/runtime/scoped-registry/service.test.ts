// Generic scoped Ref-Map registry primitive — tests.
//
// Covers the contract the L0 substrate exposes: register / lookup
// (strict + non-failing), typed missing-key error, snapshot
// enumeration, scope-bound lifecycle (each scope materializes an
// independent ref-map), multiple distinct registries coexisting
// in the same scope, and the `changes` Stream.

import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect';

import {
	defineScopedRefMap,
	ScopedRefMapKeyMissingError,
} from '../../../../src/substrate/runtime/scoped-registry/index.ts';

// ---------------------------------------------------------------
// Test-only branded key + value shapes — substrate sees only K, V.
// ---------------------------------------------------------------
type FooKey = string & { readonly _brand: 'FooKey' };
const fooKey = (s: string): FooKey => s as FooKey;
interface FooValue {
	readonly tag: string;
	readonly n: number;
}

type BarKey = string & { readonly _brand: 'BarKey' };
const barKey = (s: string): BarKey => s as BarKey;
interface BarValue {
	readonly label: string;
}

describe('defineScopedRefMap', () => {
	it.effect('set + get round-trips', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			yield* reg.set(fooKey('a'), { tag: 'apple', n: 1 });
			yield* reg.set(fooKey('b'), { tag: 'banana', n: 2 });
			const a = yield* reg.get(fooKey('a'));
			const b = yield* reg.get(fooKey('b'));
			expect(a).toEqual({ tag: 'apple', n: 1 });
			expect(b).toEqual({ tag: 'banana', n: 2 });
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('set overwrites on duplicate key (last-write-wins)', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			yield* reg.set(fooKey('a'), { tag: 'first', n: 1 });
			yield* reg.set(fooKey('a'), { tag: 'second', n: 2 });
			const a = yield* reg.get(fooKey('a'));
			expect(a).toEqual({ tag: 'second', n: 2 });
			const all = yield* reg.entries();
			expect(all).toHaveLength(1);
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('get fails with ScopedRefMapKeyMissingError on absent key', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			const result = yield* reg.get(fooKey('absent')).pipe(Effect.flip);
			expect(result).toBeInstanceOf(ScopedRefMapKeyMissingError);
			expect(result._tag).toBe('ScopedRefMapKeyMissingError');
			expect(result.registryName).toBe('Foo');
			expect(result.key).toBe('absent');
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('find returns null on absent key (no error)', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			yield* reg.set(fooKey('here'), { tag: 'x', n: 0 });
			const present = yield* reg.find(fooKey('here'));
			const absent = yield* reg.find(fooKey('nope'));
			expect(present).toEqual({ tag: 'x', n: 0 });
			expect(absent).toBeNull();
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('has reports presence without an error projection', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			yield* reg.set(fooKey('a'), { tag: 'a', n: 0 });
			const yes = yield* reg.has(fooKey('a'));
			const no = yield* reg.has(fooKey('b'));
			expect(yes).toBe(true);
			expect(no).toBe(false);
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('entries returns all pairs in insertion order', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			yield* reg.set(fooKey('c'), { tag: 'c', n: 3 });
			yield* reg.set(fooKey('a'), { tag: 'a', n: 1 });
			yield* reg.set(fooKey('b'), { tag: 'b', n: 2 });
			const all = yield* reg.entries();
			expect(all.map(([k]) => k)).toEqual(['c', 'a', 'b']);
			expect(all.map(([, v]) => v.n)).toEqual([3, 1, 2]);
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('entries on a fresh registry is empty', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			const all = yield* reg.entries();
			expect(all).toEqual([]);
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('two distinct ref-maps in one scope do not interfere', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		const Bar = defineScopedRefMap<BarKey, BarValue>('Bar');
		return Effect.gen(function* () {
			const foo = yield* Foo.Service;
			const bar = yield* Bar.Service;

			yield* foo.set(fooKey('shared'), { tag: 'in-foo', n: 1 });
			yield* bar.set(barKey('shared'), { label: 'in-bar' });

			const fooHit = yield* foo.get(fooKey('shared'));
			const barHit = yield* bar.get(barKey('shared'));
			expect(fooHit).toEqual({ tag: 'in-foo', n: 1 });
			expect(barHit).toEqual({ label: 'in-bar' });

			// Bar has no key 'absent-in-foo' the way Foo has none either —
			// the registries are completely independent.
			const fooEntries = yield* foo.entries();
			const barEntries = yield* bar.entries();
			expect(fooEntries).toHaveLength(1);
			expect(barEntries).toHaveLength(1);
		}).pipe(Effect.provide(Layer.mergeAll(Foo.layer, Bar.layer)));
	});

	it.effect('scope-bound lifecycle — entries reset across independent scopes', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');

		const runInFreshScope = (writeValue: FooValue) =>
			Effect.gen(function* () {
				const reg = yield* Foo.Service;
				yield* reg.set(fooKey('a'), writeValue);
				return yield* reg.entries();
			}).pipe(Effect.provide(Foo.layer));

		return Effect.gen(function* () {
			const first = yield* runInFreshScope({ tag: 'first', n: 1 });
			const second = yield* runInFreshScope({ tag: 'second', n: 2 });
			// Each scope got its own ref-map; the second saw an empty
			// registry until it wrote its own value.
			expect(first).toEqual([['a', { tag: 'first', n: 1 }]]);
			expect(second).toEqual([['a', { tag: 'second', n: 2 }]]);
		});
	});

	it.effect('changes stream emits the current snapshot then per-update snapshots', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			const ready = yield* Deferred.make<void>();

			// Mirrors the documented SubscriptionRef.changes pattern:
			// gate the publisher behind a Deferred that the subscriber
			// fulfils on its first emission. Avoids a race where `set`
			// runs before the PubSub subscriber registers.
			const fiber = yield* reg.changes.pipe(
				Stream.tap(() => Deferred.succeed(ready, void 0)),
				Stream.take(3),
				Stream.runCollect,
				Effect.forkChild,
			);

			yield* Deferred.await(ready);
			yield* reg.set(fooKey('a'), { tag: 'a', n: 1 });
			yield* reg.set(fooKey('b'), { tag: 'b', n: 2 });

			const seen = yield* Fiber.join(fiber);
			expect(seen).toHaveLength(3);
			// First emission is the initial empty snapshot; subsequent
			// emissions reflect each set.
			expect(seen[0]).toEqual([]);
			expect(seen[1]?.map(([k]) => k)).toEqual(['a']);
			expect(seen[2]?.map(([k]) => k)).toEqual(['a', 'b']);
		}).pipe(Effect.provide(Foo.layer));
	});

	it.effect('changes helper mirrors the service .changes property', () => {
		const Foo = defineScopedRefMap<FooKey, FooValue>('Foo');
		return Effect.gen(function* () {
			const reg = yield* Foo.Service;
			// Both forms reference the same SubscriptionRef-backed stream.
			const fromService = reg.changes;
			const fromHelper = Foo.changes(reg);
			expect(fromHelper).toBe(fromService);
		}).pipe(Effect.provide(Foo.layer));
	});
});
