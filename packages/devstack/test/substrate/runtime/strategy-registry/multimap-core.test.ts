// Seq-tagged multimap core — tests, driven through the StrategyRegistry
// public surface.
//
// The seq-tagged multimap that backs the StrategyRegistry used to live in
// a standalone `scoped-registry/` substrate module with its own unit
// suite. That module was inlined INTO `strategy-registry/service.ts`
// (one consumer, one place), so this suite re-homes the primitive's
// still-unique coverage onto the registry's PUBLIC surface
// (`register` / `get` / `list` on `StrategyRegistryService`):
//
//   - seq stamping is monotonic per registration (observable via the
//     priority-TIE tiebreak: later seq wins),
//   - entries accumulate as a per-key LIST in registration order
//     (observable via that same last-write-wins fold over the list),
//   - `list()` reflects every key with a surviving entry, and an
//     unregistered key resolves to StrategyNotFoundError.
//
// The drop-by-seq finalizer + uninterruptible close-order guarantees are
// pinned separately in `sibling-scope.test.ts`. Keys/values are OPAQUE
// strings (substrate is name-blind) — no plugin names.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';

import {
	StrategyRegistryService,
	layerStrategyRegistry,
} from '../../../../src/substrate/runtime/strategy-registry/index.ts';

interface StubStrategy {
	readonly id: string;
}
const stub = (id: string): StubStrategy => ({ id });

describe('strategy-registry seq-tagged multimap core', () => {
	it.effect(
		'register stamps a fresh monotonic seq: priority-tie resolves to the LATER registration',
		() =>
			// Two registrations under the SAME key with EQUAL priority. The
			// only thing that can break the tie is the monotonic seq stamped
			// per registration — `get` must return the LATER one (higher seq).
			// If `register` reused/froze the seq, the winner-fold could not
			// distinguish them and the earlier could win.
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const key = 'cap:slot';
					const first = stub('first');
					const second = stub('second');

					yield* registry.register(key, first, { priority: 5 });
					yield* registry.register(key, second, { priority: 5 });

					expect(yield* registry.get<typeof key, StubStrategy>(key)).toBe(second);
				}).pipe(Effect.provide(layerStrategyRegistry)),
			),
	);

	it.effect(
		'entries accumulate as a per-key LIST: higher priority wins regardless of registration order',
		() =>
			// Three entries under one key — the list survives in registration
			// order and the winner-fold scans the whole list (priority DESC,
			// then seq DESC). The highest-priority entry wins even though it
			// is neither first nor last to register, proving the registry
			// keeps the LIST (not a single collapsed value).
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const key = 'cap:slot';
					const lo = stub('lo');
					const hi = stub('hi');
					const mid = stub('mid');

					yield* registry.register(key, lo, { priority: 1 });
					yield* registry.register(key, hi, { priority: 9 });
					yield* registry.register(key, mid, { priority: 5 });

					expect(yield* registry.get<typeof key, StubStrategy>(key)).toBe(hi);
				}).pipe(Effect.provide(layerStrategyRegistry)),
			),
	);

	it.effect('list() reflects every key with a surviving entry', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				yield* registry.register('cap:a', stub('a'));
				yield* registry.register('cap:b', stub('b'));

				expect(new Set(yield* registry.list())).toEqual(new Set(['cap:a', 'cap:b']));
			}).pipe(Effect.provide(layerStrategyRegistry)),
		),
	);

	it.effect('an absent key resolves to StrategyNotFoundError and is absent from list()', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;

				expect(yield* registry.list()).not.toContain('cap:nope');
				const exit = yield* Effect.exit(
					registry.get<'cap:nope', StubStrategy>('cap:nope'),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					expect(err.value._tag).toBe('StrategyNotFoundError');
				}
			}).pipe(Effect.provide(layerStrategyRegistry)),
		),
	);

	it.effect(
		'drop-by-seq on scope close: closing an inner registration leaves the outer list entry intact',
		() =>
			// The per-key list + drop-by-seq finalizer in one place: an outer
			// registration and an inner (separate scope) registration coexist
			// under the same key (outer wins on higher priority). When the
			// inner scope closes, ONLY its entry is dropped — the outer list
			// entry survives and still resolves. (The full sibling-scope /
			// uninterruptible matrix lives in `sibling-scope.test.ts`.)
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const key = 'cap:slot';
				const outer = stub('outer');
				const inner = stub('inner');

				const outerScope = yield* Scope.make();
				yield* Scope.provide(registry.register(key, outer, { priority: 10 }), outerScope);

				const innerScope = yield* Scope.make();
				yield* Scope.provide(registry.register(key, inner, { priority: 0 }), innerScope);

				// Both live: outer wins (higher priority).
				expect(yield* registry.get<typeof key, StubStrategy>(key)).toBe(outer);

				// Close only the inner scope — its entry drops, outer survives.
				yield* Scope.close(innerScope, Exit.void);
				expect(yield* registry.get<typeof key, StubStrategy>(key)).toBe(outer);
				expect(yield* registry.list()).toContain(key);

				yield* Scope.close(outerScope, Exit.void);
			}).pipe(Effect.scoped, Effect.provide(layerStrategyRegistry)),
	);
});
