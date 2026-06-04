// Scoped seq-tagged registry primitive.
//
// ONE storage + finalizer + snapshot core, TWO primitives over it:
//
//   - `makeScopedMultimap<K, V>()` — the raw seq-tagged multimap.
//     The `StrategyRegistry` is built on it: a store of a per-key LIST
//     of seq-tagged entries plus a per-registration scope finalizer that
//     drops the entries it added when the surrounding scope closes.
//     The winner policy (priority+seq) is folded at the call site over
//     the snapshot this primitive exposes — the registry needs the RAW
//     `MultimapEntry{value,seq}` for that fold, not a pre-folded
//     value — hence the multimap surface stays.
//
//   - `defineScopedRefMap<K, V>(name)` — a typed `Context.Service`
//     factory over the SAME core, exposing a last-write-wins `K -> V`
//     projection (set/get/find/has/entries/changes). Each call returns
//     a fresh Service class keyed by `name`. Used by coin/package.
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
//     live overlay.
//
//   - The seq-tagged list makes every finalizer remove ONLY the entry
//     (or entries) it added — it never touches a newer registration for
//     the same key. "Who wins right now" is a pure function of the
//     surviving entries (highest seq = last-write-wins), so close order
//     does not matter.
//
// The single-mode projection is LWW over exactly this store: each
// `set` is a fresh-seq filter-then-append (it drops the prior same-key
// entry so the store holds STRICTLY one entry per key — no per-set
// finalizer bounds it otherwise), `find`/`get` read that lone entry,
// and `entries` orders keys by their entry's seq — which reproduces the
// old append-after-filter SubscriptionRef array verbatim (re-setting a
// key advances its seq, so it sorts to the end exactly as the prior
// implementation moved it).
//
// Scope-local, like every substrate registry: the backing
// `SubscriptionRef` is private to the build effect, so it dies with
// the stack scope. (A `SubscriptionRef` is used so single mode can
// expose `.changes`; the multimap surface simply never reads it, and
// its update/get semantics are identical to a plain `Ref`.)

import { Context, Effect, Layer, Ref, Schema, Stream, SubscriptionRef, type Scope } from 'effect';

// -----------------------------------------------------------------------------
// Shared types — the seq-tagged store.
// -----------------------------------------------------------------------------

/** One stored entry: the caller's `value` plus the monotonic `seq` the
 *  multimap stamped it with. The `seq` is the identity the finalizer
 *  drops on and the tiebreaker call sites fold on. */
export interface MultimapEntry<V> {
	readonly value: V;
	readonly seq: number;
}

/** A single `(key, value)` pair to register. A registration may carry
 *  several pairs; all pairs in one `register` call share one `seq` and
 *  one finalizer. */
interface MultimapItem<K extends string, V> {
	readonly key: K;
	readonly value: V;
}

/** Operations on a scoped seq-tagged multimap. Generic over `K`
 *  (string-shaped, used as a Map key) and the opaque per-entry `V`. */
interface ScopedMultimap<K extends string, V> {
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

/** Pure single-mode store mutation: replace `key`'s entry list with a SINGLE
 *  `(value, seq)` entry (filter-then-append). Dropping any prior same-key entry
 *  keeps the store at exactly one entry per key — single mode has no per-set
 *  finalizer to bound it, so a plain append would leak history for the whole
 *  layer scope. Exported so the one-entry-per-key invariant is unit-testable
 *  without the SubscriptionRef plumbing. */
export const setSingleEntry = <K extends string, V>(
	state: State<K, V>,
	key: K,
	value: V,
	seq: number,
): State<K, V> => {
	const next = new Map(state);
	next.set(key, [{ value, seq }]);
	return next;
};

/** The shared core: the seq-tagged store + its ops, plus the backing
 *  `SubscriptionRef` so single mode can expose `.changes`, and a
 *  scope-free LWW `setSingle` the single-mode projection writes
 *  through. Multimap callers ignore `ref`/`setSingle`. */
interface ScopedRegistryCore<K extends string, V> extends ScopedMultimap<K, V> {
	readonly ref: SubscriptionRef.SubscriptionRef<State<K, V>>;
	/** Stamp a fresh `seq` and replace `key`'s entry with `(value, seq)`
	 *  (filter-then-append) WITHOUT a finalizer. The LWW single-mode
	 *  surface lives for the whole layer scope (the old `defineScopedRefMap`
	 *  had no per-set reaping), so it needs no `Scope.Scope` — keeping
	 *  `set: Effect.Effect<void>`. Dropping the prior same-key entry keeps
	 *  the store at one entry per key (no unbounded history); the monotonic
	 *  `seq` still drives last-write-wins + insertion order. */
	readonly setSingle: (key: K, value: V) => Effect.Effect<void>;
}

/**
 * Construct the shared seq-tagged core. The append + drop-by-seq
 * finalizer pair is `uninterruptible` so an interrupt arriving between
 * the two can't leak an entry past scope close (mirrors
 * `leaseBroker.tryAcquire`). The finalizer touches only the entries
 * THIS registration added — never a newer registration for the same
 * key — so sibling-scope close order is irrelevant.
 */
const makeScopedRegistryCore = <K extends string, V>(): Effect.Effect<ScopedRegistryCore<K, V>> =>
	Effect.gen(function* () {
		const ref = yield* SubscriptionRef.make<State<K, V>>(new Map());
		const seqRef = yield* Ref.make(0);

		const register: ScopedMultimap<K, V>['register'] = (items) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				yield* SubscriptionRef.update(ref, (current) => {
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
					SubscriptionRef.update(ref, (current) => {
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

		const setSingle: ScopedRegistryCore<K, V>['setSingle'] = (key, value) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				// FILTER-then-append (see `setSingleEntry`): single mode is
				// last-write-wins with NO per-set finalizer (the LWW surface lives
				// for the whole layer scope), so a plain append would let prior
				// same-key entries accumulate for the stack lifetime — O(history)
				// lookups + leaked memory. The fresh `seq` still drives insertion
				// order (a re-set sorts to the end), so `projectEntries`/`changes`
				// are byte-identical.
				yield* SubscriptionRef.update(ref, (current) =>
					setSingleEntry(current, key, value, seq),
				);
			});

		const entriesFor: ScopedMultimap<K, V>['entriesFor'] = (key) =>
			SubscriptionRef.get(ref).pipe(Effect.map((current) => current.get(key) ?? []));

		const snapshot: ScopedMultimap<K, V>['snapshot'] = SubscriptionRef.get(ref);

		const keys: ScopedMultimap<K, V>['keys'] = SubscriptionRef.get(ref).pipe(
			Effect.map((current) => [...current.keys()]),
		);

		return { register, entriesFor, snapshot, keys, ref, setSingle } as const;
	});

/**
 * Construct a fresh scoped multimap. Call this inside a Layer build
 * effect (the registry's `Layer.effect` body); the returned ops close
 * over a private store that lives for that Layer's scope.
 *
 * `register` is interruption-safe: the append + finalizer-wire pair is
 * `uninterruptible`, so an interrupt arriving between the two can't
 * leak an entry past scope close (mirrors `leaseBroker.tryAcquire`).
 */
export const makeScopedMultimap = <K extends string, V>(): Effect.Effect<ScopedMultimap<K, V>> =>
	makeScopedRegistryCore<K, V>().pipe(
		// Drop the internal `ref` handle — the multimap surface is the
		// register/entriesFor/snapshot/keys quartet only.
		Effect.map(({ register, entriesFor, snapshot, keys }) => ({
			register,
			entriesFor,
			snapshot,
			keys,
		})),
	);

// -----------------------------------------------------------------------------
// Single-mode (last-write-wins) projection — the former ScopedRefMap.
// -----------------------------------------------------------------------------

/** Lookup failure for a missing key. Schema-tagged so consumers
 *  may `Effect.catchTag('ScopedRefMapKeyMissingError', ...)` and
 *  the cascade-formatter can render it without importing the class. */
export class ScopedRefMapKeyMissingError extends Schema.TaggedErrorClass<ScopedRefMapKeyMissingError>()(
	'ScopedRefMapKeyMissingError',
	{
		registryName: Schema.String,
		key: Schema.String,
	},
) {}

/** Operations on a scoped `K -> V` ref-map. Generic over `K`
 *  (constrained to `string`-shaped brands so it can be used as
 *  a Map key) and `V` (fully opaque to substrate). */
export interface ScopedRefMap<K extends string, V> {
	/** Insert / overwrite. Last-write-wins on `K`. */
	readonly set: (key: K, value: V) => Effect.Effect<void>;
	/** Strict lookup. Fails with `ScopedRefMapKeyMissingError`
	 *  when the key isn't present. */
	readonly get: (key: K) => Effect.Effect<V, ScopedRefMapKeyMissingError>;
	/** Non-failing lookup — `null` when absent. */
	readonly find: (key: K) => Effect.Effect<V | null>;
	/** Presence check without an error projection. */
	readonly has: (key: K) => Effect.Effect<boolean>;
	/** Snapshot of all `(key, value)` pairs. Iteration order is
	 *  insertion order. */
	readonly entries: () => Effect.Effect<ReadonlyArray<readonly [K, V]>>;
	/** Stream of full-snapshot states. Each emission is the
	 *  current `entries` array; consumers diff if they need
	 *  incremental updates. */
	readonly changes: Stream.Stream<ReadonlyArray<readonly [K, V]>>;
}

/** Fold a key's surviving seq-tagged entries to the winner — highest
 *  seq wins (last-write-wins). Returns the winning entry or undefined
 *  when the key has no surviving entries. */
const winningEntry = <V>(
	entries: ReadonlyArray<MultimapEntry<V>>,
): MultimapEntry<V> | undefined => {
	let best: MultimapEntry<V> | undefined;
	for (const e of entries) {
		if (best === undefined || e.seq > best.seq) best = e;
	}
	return best;
};

/** Project the seq-tagged store snapshot to an insertion-ordered
 *  `[K, V]` array. Each key maps to its winning entry; keys are
 *  ordered by their winning entry's seq, which reproduces the old
 *  append-after-filter array order verbatim (re-setting a key advances
 *  its seq → it sorts to the end, exactly as before). */
const projectEntries = <K extends string, V>(
	state: State<K, V>,
): ReadonlyArray<readonly [K, V]> => {
	const winners: Array<{ key: K; entry: MultimapEntry<V> }> = [];
	for (const [key, entries] of state) {
		const win = winningEntry(entries);
		if (win !== undefined) winners.push({ key, entry: win });
	}
	winners.sort((a, b) => a.entry.seq - b.entry.seq);
	return winners.map(({ key, entry }) => [key, entry.value] as const);
};

const makeSingleSurface = <K extends string, V>(
	core: ScopedRegistryCore<K, V>,
	name: string,
): ScopedRefMap<K, V> => {
	const set: ScopedRefMap<K, V>['set'] = (key, value) => core.setSingle(key, value);

	const find: ScopedRefMap<K, V>['find'] = (key) =>
		core.entriesFor(key).pipe(Effect.map((entries) => winningEntry(entries)?.value ?? null));

	const get: ScopedRefMap<K, V>['get'] = (key) =>
		Effect.gen(function* () {
			const value = yield* find(key);
			if (value === null) {
				return yield* new ScopedRefMapKeyMissingError({
					registryName: name,
					key,
				});
			}
			return value;
		});

	const has: ScopedRefMap<K, V>['has'] = (key) =>
		core.entriesFor(key).pipe(Effect.map((entries) => entries.length > 0));

	const entries: ScopedRefMap<K, V>['entries'] = () =>
		core.snapshot.pipe(Effect.map(projectEntries));

	const changes: ScopedRefMap<K, V>['changes'] = SubscriptionRef.changes(core.ref).pipe(
		Stream.map(projectEntries),
	);

	return { set, get, find, has, entries, changes };
};

// -----------------------------------------------------------------------------
// defineScopedRefMap — the typed Context.Service factory.
// -----------------------------------------------------------------------------

/**
 * Factory: a last-write-wins `ScopedRefMap<K, V>` service over the
 * shared seq-tagged core: `set`/`get`/`find`/`has`/`entries`/`changes`,
 * insertion order, `get` fails with `ScopedRefMapKeyMissingError`.
 *
 * The `name` becomes both the human-readable registry name (used in
 * `ScopedRefMapKeyMissingError.registryName`) and the Context.Service
 * identifier `@devstack/substrate/ScopedRefMap/${name}`. Each call
 * returns a fresh Service class; calling twice with the same name
 * produces two distinct services (Context.Service identity is per-class,
 * not per-id-string — the id string is a debugging aid). The return
 * type is left to inference so the inner Service class's identity flows
 * through to callers.
 *
 * `Service` is a `Context.Service` tag class plugin authors yield from
 * their `acquire` body; `layer` is the scope-bound Layer. Used by
 * coin/package.
 */
const defineSingle = <K extends string, V>(name: string) => {
	const serviceId = `@devstack/substrate/ScopedRefMap/${name}`;

	class Service extends Context.Service<Service, ScopedRefMap<K, V>>()(serviceId) {}

	const layer: Layer.Layer<Service> = Layer.effect(
		Service,
		makeScopedRegistryCore<K, V>().pipe(
			Effect.map((core) => Service.of(makeSingleSurface(core, name))),
		),
	);

	return { Service, layer } as const;
};

/**
 * Declare a typed `K -> V` scoped registry service over the shared
 * seq-tagged core — a last-write-wins `ScopedRefMap<K, V>`. Used by
 * coin/package.
 */
export const defineScopedRefMap = <K extends string, V>(name: string) => defineSingle<K, V>(name);
