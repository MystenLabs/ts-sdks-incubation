// Scoped seq-tagged multimap primitive.
//
// Three substrate registries — `StrategyRegistry`, `FormatterRegistry`,
// `CapabilitySinks` — independently grew the same shape: a `Ref` of a
// per-key LIST of seq-tagged entries, plus a per-registration scope
// finalizer that drops the entries it added when the surrounding scope
// closes. This module is the ONE place that shape lives.
//
// Why a per-key LIST tagged by a monotonic seq (rather than a single
// value-per-key with prior-restore):
//
//   - Parallel / sibling-scope safety. The naive "remember the prior
//     value, restore it on close" finalizer is only correct under
//     strict LIFO nesting. With sibling scopes it clobbers a still-live
//     registration: scope A installs `X`, sibling B overwrites `X`
//     (capturing A's value as its `prior`), then A closes first and its
//     finalizer — holding `prior = nothing` — DELETES `X`, dropping B's
//     live overlay. capability-sinks had exactly this bug.
//
//   - The seq-tagged list makes every finalizer remove ONLY the entry
//     (or entries) it added — it never touches a newer registration for
//     the same key. "Who wins right now" is a pure function of the
//     surviving entries (highest seq = last-write-wins), so close order
//     no longer matters.
//
// The primitive deliberately stops at the storage + finalizer layer.
// The "winner" policy differs per registry (priority+seq, non-null
// formatter+seq, plain last-seq), so each call site folds the surviving
// entries with its own rule over the snapshot this primitive exposes.
//
// Scope-local, like every substrate registry: the `Ref` is private to
// the build effect, so it dies with the stack scope.

import { Effect, Ref, type Scope } from 'effect';

/** One stored entry: the caller's `value` plus the monotonic `seq` the
 *  multimap stamped it with. The `seq` is the identity the finalizer
 *  drops on and the tiebreaker call sites fold on. */
export interface MultimapEntry<V> {
	readonly value: V;
	readonly seq: number;
}

/** A single `(key, value)` pair to register. A registration may carry
 *  several pairs (formatter-registry contributes one tag-entry per
 *  declared error tag); all pairs in one `register` call share one
 *  `seq` and one finalizer. */
export interface MultimapItem<K extends string, V> {
	readonly key: K;
	readonly value: V;
}

/** Operations on a scoped seq-tagged multimap. Generic over `K`
 *  (string-shaped, used as a Map key) and the opaque per-entry `V`. */
export interface ScopedMultimap<K extends string, V> {
	/** Append one or more `(key, value)` pairs under a single fresh
	 *  `seq`, and register a scope finalizer that drops exactly those
	 *  entries (by `seq`) on scope close. Returns the assigned `seq` so
	 *  callers that need to span-annotate or correlate can.
	 *
	 *  Requires `Scope.Scope`: the finalizer lands on the caller's
	 *  scope, so the registration is reaped on that scope's close. */
	readonly register: (
		items: ReadonlyArray<MultimapItem<K, V>>,
	) => Effect.Effect<number, never, Scope.Scope>;
	/** Surviving entries under one key, in registration order
	 *  (ascending `seq`). Empty array when the key is absent. */
	readonly entriesFor: (key: K) => Effect.Effect<ReadonlyArray<MultimapEntry<V>>>;
	/** Full snapshot: every key mapped to its surviving entries. */
	readonly snapshot: Effect.Effect<ReadonlyMap<K, ReadonlyArray<MultimapEntry<V>>>>;
	/** Keys with at least one surviving entry. */
	readonly keys: Effect.Effect<ReadonlyArray<K>>;
}

type State<K extends string, V> = ReadonlyMap<K, ReadonlyArray<MultimapEntry<V>>>;

/**
 * Construct a fresh scoped multimap. Call this inside a Layer build
 * effect (the registry's `Layer.effect` body); the returned ops close
 * over a private `Ref` that lives for that Layer's scope.
 *
 * `register` is interruption-safe: the append + finalizer-wire pair is
 * `uninterruptible`, so an interrupt arriving between the two can't
 * leak an entry past scope close (mirrors `leaseBroker.tryAcquire`).
 */
export const makeScopedMultimap = <K extends string, V>(): Effect.Effect<ScopedMultimap<K, V>> =>
	Effect.gen(function* () {
		const state = yield* Ref.make<State<K, V>>(new Map());
		const seqRef = yield* Ref.make(0);

		const register: ScopedMultimap<K, V>['register'] = (items) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				yield* Ref.update(state, (current) => {
					const next = new Map(current);
					for (const item of items) {
						const existing = next.get(item.key) ?? [];
						next.set(item.key, [...existing, { value: item.value, seq }]);
					}
					return next;
				});
				// Drop-by-seq finalizer. Touches only the entries THIS
				// registration added — never a newer registration for the
				// same key — so sibling-scope close order is irrelevant.
				yield* Effect.addFinalizer((_exit) =>
					Ref.update(state, (current) => {
						const next = new Map(current);
						for (const item of items) {
							const existing = next.get(item.key);
							if (!existing) continue;
							const filtered = existing.filter((e) => e.seq !== seq);
							if (filtered.length === 0) next.delete(item.key);
							else next.set(item.key, filtered);
						}
						return next;
					}),
				);
				return seq;
			}).pipe(Effect.uninterruptible);

		const entriesFor: ScopedMultimap<K, V>['entriesFor'] = (key) =>
			Ref.get(state).pipe(Effect.map((current) => current.get(key) ?? []));

		const snapshot: ScopedMultimap<K, V>['snapshot'] = Ref.get(state);

		const keys: ScopedMultimap<K, V>['keys'] = Ref.get(state).pipe(
			Effect.map((current) => [...current.keys()]),
		);

		return { register, entriesFor, snapshot, keys } as const;
	});
