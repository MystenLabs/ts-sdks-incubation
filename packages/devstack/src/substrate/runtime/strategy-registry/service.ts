// Strategy registry implementation.
//
// Architecture § StrategyContributor — generic capability-keyed
// pub/sub for plugin-contributed strategies (faucet strategies,
// network resolvers, account selection, etc.).
//
// Per-capability-key LIST of contributing plugins (a registry can
// hold multiple contributions for the same key). Resolution is
// ordered by registration time; the selector chooses among them.
//
// Scope-local. The registry is created per-stack-scope so parallel
// stacks isolate. When the stack scope closes, the registry's
// entries die with it (the architecture's "scope-local, never
// module-level" rule).

import { Context, Effect, Layer, Ref, Scope } from 'effect';

import type { StrategyRegistry } from '../../../contracts/strategy-contributor.ts';
import { StrategyNotFoundError } from '../errors.ts';

/** One registered strategy under a capability key. The store stamps
 *  the registration `seq`; the payload carries the strategy + its
 *  visibility/priority. We keep the LIST (not the single winner)
 *  because:
 *   1. Renderers want to enumerate "N contributors registered".
 *   2. The selector is per-strategy and may inspect all of them.
 *   3. Auto-mounted vs user-supplied is a visibility distinction
 *      consumers need to surface separately. */
interface Entry {
	readonly strategy: unknown;
	readonly autoMounted: boolean;
	readonly priority: number;
}

/** One stored entry: the caller's `Entry` plus the monotonic `seq` the
 *  store stamped it with. The `seq` is the identity the finalizer drops
 *  on and the winner-fold tiebreaks on.
 *
 *  Why a per-key LIST tagged by a monotonic seq (rather than a single
 *  value-per-key with prior-restore):
 *
 *    - Parallel / sibling-scope safety. The naive "remember the prior
 *      value, restore it on close" finalizer is only correct under
 *      strict LIFO nesting. With sibling scopes it clobbers a still-live
 *      registration: scope A installs `X`, sibling B overwrites `X`
 *      (capturing A's value as its `prior`), then A closes first and its
 *      finalizer — holding `prior = nothing` — DELETES `X`, dropping B's
 *      live overlay.
 *
 *    - The seq-tagged list makes every finalizer remove ONLY the entry
 *      it added — it never touches a newer registration for the same
 *      key. "Who wins right now" is a pure function of the surviving
 *      entries (priority, then seq), so close order does not matter. */
interface StoredEntry {
	readonly value: Entry;
	readonly seq: number;
}

type Store = ReadonlyMap<string, ReadonlyArray<StoredEntry>>;

export class StrategyRegistryService extends Context.Service<
	StrategyRegistryService,
	StrategyRegistry
>()('@devstack/substrate/StrategyRegistry') {}

/**
 * Layer. Constructed per-scope; the orchestrator hands the registry
 * to each plugin's acquire so contributions land on the right
 * stack's registry, not a global one.
 */
export const layerStrategyRegistry: Layer.Layer<StrategyRegistryService> = Layer.effect(
	StrategyRegistryService,
	Effect.gen(function* () {
		// Scope-local seq-tagged store. The backing `Ref`s are private to
		// this build effect, so they die with the stack scope (the
		// architecture's "scope-local, never module-level" rule). `seqRef`
		// stamps a fresh monotonic seq per registration; `ref` holds the
		// per-key LIST of surviving seq-tagged entries.
		const ref = yield* Ref.make<Store>(new Map());
		const seqRef = yield* Ref.make(0);

		// `entriesFor` — surviving entries under one key, in registration
		// order (ascending seq). Empty array when the key is absent.
		const entriesFor = (key: string): Effect.Effect<ReadonlyArray<StoredEntry>> =>
			Ref.get(ref).pipe(Effect.map((current) => current.get(key) ?? []));

		// `keys` — keys with at least one surviving entry.
		const keys: Effect.Effect<ReadonlyArray<string>> = Ref.get(ref).pipe(
			Effect.map((current) => [...current.keys()]),
		);

		const register: StrategyRegistry['register'] = <Key extends string, S>(
			key: Key,
			strategy: S,
			options?: { readonly autoMounted?: boolean; readonly priority?: number },
		) =>
			Effect.gen(function* () {
				const entry: Entry = {
					strategy,
					autoMounted: options?.autoMounted ?? false,
					priority: options?.priority ?? 0,
				};
				// Stamp a fresh monotonic seq, append the entry under `key`,
				// and wire a drop-by-seq finalizer onto the CALLER's scope.
				// The append + finalizer-wire pair is `uninterruptible`, so an
				// interrupt arriving between the two can't leak an entry past
				// scope close. The finalizer touches only the entry THIS
				// registration added — never a newer registration for the same
				// key — so sibling-scope close order is irrelevant.
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				yield* Ref.update(ref, (current) => {
					const next = new Map(current);
					const existing = next.get(key) ?? [];
					next.set(key, [...existing, { value: entry, seq }]);
					return next;
				});
				yield* Effect.addFinalizer((_exit) =>
					Ref.update(ref, (current) => {
						const next = new Map(current);
						const existing = next.get(key);
						if (existing) {
							const filtered = existing.filter((e) => e.seq !== seq);
							if (filtered.length === 0) next.delete(key);
							else next.set(key, filtered);
						}
						return next;
					}),
				);
			}).pipe(Effect.uninterruptible) as Effect.Effect<void, never, Scope.Scope>;

		const get: StrategyRegistry['get'] = <Key extends string, S>(key: Key) =>
			Effect.gen(function* () {
				const entries = yield* entriesFor(key);
				if (entries.length === 0) {
					const registeredKeys = yield* keys;
					return yield* new StrategyNotFoundError({
						capabilityKey: key,
						registeredKeys,
					});
				}
				// Resolution policy:
				//   1. Higher priority wins.
				//   2. Tie on priority → later registration wins
				//      (last-write-wins for user overrides of
				//      built-ins — matches architecture § failure
				//      modes "two strategies with the same key and
				//      same priority → last write wins").
				let best = entries[0]!;
				for (let i = 1; i < entries.length; i++) {
					const e = entries[i]!;
					if (
						e.value.priority > best.value.priority ||
						(e.value.priority === best.value.priority && e.seq > best.seq)
					) {
						best = e;
					}
				}
				return best.value.strategy as S;
			});

		const list: StrategyRegistry['list'] = () => keys;

		return StrategyRegistryService.of({
			get: get as StrategyRegistry['get'],
			register: register as StrategyRegistry['register'],
			list,
		});
	}),
);
