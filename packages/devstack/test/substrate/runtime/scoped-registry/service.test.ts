// Scoped seq-tagged multimap primitive — tests.
//
// Covers the one remaining export of the scoped-registry substrate
// primitive: `makeScopedMultimap`. The StrategyRegistry is built on
// it; the sibling-scope close-order guarantees are pinned end-to-end
// in `strategy-registry/sibling-scope.test.ts`. These tests exercise
// the primitive directly: seq stamping, per-key entry lists, the
// drop-by-seq finalizer, and the snapshot/keys surface.
//
// (The former single-mode `defineScopedRefMap` cases moved to the
// coin/package plugin registry suites when single mode was strangled
// out of substrate.)

import { describe, expect, it } from '@effect/vitest';
import { Effect, Scope } from 'effect';

import { makeScopedMultimap } from '../../../../src/substrate/runtime/scoped-registry/index.ts';

type FooKey = string & { readonly _brand: 'FooKey' };
const fooKey = (s: string): FooKey => s as FooKey;
interface FooValue {
	readonly tag: string;
}

describe('makeScopedMultimap', () => {
	it.effect('register stamps a fresh monotonic seq per call', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const mm = yield* makeScopedMultimap<FooKey, FooValue>();
				const s1 = yield* mm.register([{ key: fooKey('a'), value: { tag: 'a1' } }]);
				const s2 = yield* mm.register([{ key: fooKey('a'), value: { tag: 'a2' } }]);
				expect(s2).toBeGreaterThan(s1);
			}),
		),
	);

	it.effect('entriesFor accumulates a per-key LIST in registration order', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const mm = yield* makeScopedMultimap<FooKey, FooValue>();
				yield* mm.register([{ key: fooKey('a'), value: { tag: 'first' } }]);
				yield* mm.register([{ key: fooKey('a'), value: { tag: 'second' } }]);
				const entries = yield* mm.entriesFor(fooKey('a'));
				expect(entries.map((e) => e.value.tag)).toEqual(['first', 'second']);
				// Ascending seq — the registration order the finalizer drops on.
				expect(entries[0]!.seq).toBeLessThan(entries[1]!.seq);
			}),
		),
	);

	it.effect('entriesFor is empty for an absent key', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const mm = yield* makeScopedMultimap<FooKey, FooValue>();
				expect(yield* mm.entriesFor(fooKey('nope'))).toEqual([]);
			}),
		),
	);

	it.effect('snapshot + keys reflect every surviving entry', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const mm = yield* makeScopedMultimap<FooKey, FooValue>();
				yield* mm.register([
					{ key: fooKey('a'), value: { tag: 'a' } },
					{ key: fooKey('b'), value: { tag: 'b' } },
				]);
				const snap = yield* mm.snapshot;
				expect(new Set(snap.keys())).toEqual(new Set(['a', 'b']));
				expect(new Set(yield* mm.keys)).toEqual(new Set(['a', 'b']));
			}),
		),
	);

	it.effect('a registration finalizer drops ONLY the entries it added on scope close', () =>
		Effect.gen(function* () {
			const mm = yield* makeScopedMultimap<FooKey, FooValue>();
			// Outer registration survives the inner scope.
			yield* mm.register([{ key: fooKey('a'), value: { tag: 'outer' } }]).pipe(
				Effect.provideService(Scope.Scope, yield* Scope.make()),
			);
			// Inner scope registers a second entry under 'a', then closes —
			// its finalizer must remove only the inner entry, leaving the
			// outer one intact (close-order-independent drop-by-seq).
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* mm.register([{ key: fooKey('a'), value: { tag: 'inner' } }]);
					const during = yield* mm.entriesFor(fooKey('a'));
					expect(during.map((e) => e.value.tag)).toEqual(['outer', 'inner']);
				}),
			);
			const after = yield* mm.entriesFor(fooKey('a'));
			expect(after.map((e) => e.value.tag)).toEqual(['outer']);
		}).pipe(Effect.scoped),
	);
});
