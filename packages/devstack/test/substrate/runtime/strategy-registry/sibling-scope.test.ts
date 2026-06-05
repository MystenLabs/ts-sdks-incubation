// Sibling-scope finalizer regression — the multimap's drop-by-SEQ contract.
//
// The StrategyRegistry is built on `makeScopedMultimap` (a per-key LIST
// of seq-tagged entries, each registration carrying a drop-by-SEQ
// finalizer). The single most dangerous behavior is what happens when
// the SAME capability key is registered in two SIBLING scopes and one
// closes: the closing scope's finalizer must drop ONLY the entry IT
// added (by `seq`), never every entry under that key (drop-by-KEY).
//
// A naive "drop-by-key" rewrite — `next.delete(key)` in the finalizer,
// or "remember prior value / restore on close" — passes every LIFO-nested
// test but silently destroys a still-live sibling registration. These
// tests pin the behavior so the planned inline of `makeScopedMultimap`
// INTO this registry (and the deletion of `scoped-registry/`) cannot
// regress it.
//
// Driven entirely through the StrategyRegistry PUBLIC surface
// (`register` / `get` / `list` on `StrategyRegistryService`), which
// survives the inline — NOT through `makeScopedMultimap` directly (that
// module gets deleted). Sibling-scope registration of the same key is
// expressible here because `register` lands its finalizer on the
// CALLER's `Scope.Scope`: provide one registry layer (one shared store)
// and run `register` under two independent `Scope.make()` scopes.
//
// Keys/values are OPAQUE strings (substrate is name-blind) — no plugin
// names.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';

import {
	StrategyRegistryService,
	layerStrategyRegistry,
} from '../../../../src/substrate/runtime/strategy-registry/index.ts';

// Opaque capability key + strategy values — substrate sees only K, V.
const CAP_KEY = 'cap:shared-slot';

interface StubStrategy {
	readonly id: string;
}
const stub = (id: string): StubStrategy => ({ id });

describe('strategy-registry sibling-scope finalizer', () => {
	it.effect(
		'drop-by-seq, not drop-by-key: closing scope A leaves sibling scope B intact',
		() =>
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;

				const valueA = stub('A');
				const valueB = stub('B');

				// Two INDEPENDENT (sibling, non-nested) scopes registering the
				// SAME key into the SAME shared store. A registers first (lower
				// seq), B second (higher seq).
				const scopeA = yield* Scope.make();
				const scopeB = yield* Scope.make();

				// A wins WHILE BOTH ARE LIVE: higher priority. This is what makes
				// the assertion strong — if A's close merely "de-prioritized" or
				// shadowed (rather than removed) its entry, B would already be the
				// winner and we couldn't distinguish drop-by-seq from drop-by-key.
				// With A's HIGHER priority winning first, the only way B becomes
				// the winner after A closes is if A's entry was actually removed
				// AND B's entry survived — exactly drop-by-seq.
				yield* Scope.provide(
					registry.register(CAP_KEY, valueA, { priority: 10 }),
					scopeA,
				);
				yield* Scope.provide(
					registry.register(CAP_KEY, valueB, { priority: 0 }),
					scopeB,
				);

				// Both live: the key resolves, and A (higher priority) wins.
				expect(yield* registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY)).toBe(valueA);
				// The key is present in the registry's key snapshot.
				expect(yield* registry.list()).toContain(CAP_KEY);

				// Close ONLY scope A. Its drop-by-seq finalizer removes A's entry
				// and must NOT touch B's (newer seq, sibling scope).
				yield* Scope.close(scopeA, Exit.void);

				// B's entry SURVIVES: the key still resolves, now to B — proving
				// A's entry was actually dropped (A had higher priority, so a
				// surviving A would still win) and B was untouched. A naive
				// drop-by-KEY finalizer would have deleted the whole key here and
				// this `get` would fail with StrategyNotFoundError.
				expect(yield* registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY)).toBe(valueB);
				expect(yield* registry.list()).toContain(CAP_KEY);

				// Cleanup: close B too — now the key is fully gone.
				yield* Scope.close(scopeB, Exit.void);
				const afterBoth = yield* Effect.exit(
					registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY),
				);
				expect(Exit.isFailure(afterBoth)).toBe(true);
			}).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect(
		'symmetric: closing the LATER sibling (B) first leaves the earlier (A) intact',
		() =>
			// Close order must not matter — the seq-tagged finalizer touches
			// only its own entry regardless of which sibling closes first. Here
			// we close B (higher seq) first; A (lower seq) must survive. A
			// drop-by-key finalizer on B's close would wipe A too.
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const valueA = stub('A');
				const valueB = stub('B');

				const scopeA = yield* Scope.make();
				const scopeB = yield* Scope.make();

				// Equal priority this time → last-write-wins on seq, so B (later)
				// wins while both are live.
				yield* Scope.provide(registry.register(CAP_KEY, valueA), scopeA);
				yield* Scope.provide(registry.register(CAP_KEY, valueB), scopeB);
				expect(yield* registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY)).toBe(valueB);

				// Close the LATER sibling first.
				yield* Scope.close(scopeB, Exit.void);

				// A survives and is now the winner; the key still resolves.
				expect(yield* registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY)).toBe(valueA);

				yield* Scope.close(scopeA, Exit.void);
			}).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect(
		'finalizer runs on an INTERRUPTED scope close — no entry leaks past close',
		() =>
			// The register append + finalizer-wire pair is `uninterruptible`, and
			// the finalizer runs on EVERY exit including interruption. Closing the
			// registration scope with an interrupt Exit must still reap the entry:
			// after close the key no longer resolves. A finalizer that skipped on
			// interrupt (or a drop-by-key that depended on an orderly exit) would
			// leak the entry.
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const value = stub('only');

				const scope = yield* Scope.make();
				yield* Scope.provide(registry.register(CAP_KEY, value), scope);

				// Live before close.
				expect(yield* registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY)).toBe(value);

				// Close with an INTERRUPT exit — the uninterruptible drop-by-seq
				// finalizer must still run.
				yield* Scope.close(scope, Exit.interrupt());

				// The entry is gone: lookup fails, and the key is absent from the
				// snapshot — nothing leaked past close.
				const exit = yield* Effect.exit(
					registry.get<typeof CAP_KEY, StubStrategy>(CAP_KEY),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					expect(err.value._tag).toBe('StrategyNotFoundError');
				}
				expect(yield* registry.list()).not.toContain(CAP_KEY);
			}).pipe(Effect.provide(layerStrategyRegistry)),
	);
});
