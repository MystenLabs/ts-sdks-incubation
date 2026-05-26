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

/** One registered strategy under a capability key. */
interface Entry {
	readonly strategy: unknown;
	readonly autoMounted: boolean;
	readonly priority: number;
	/** Sequence number for stable ordering by registration time. */
	readonly seq: number;
}

/** Per-capability-key contributions. We keep the LIST (not the
 *  single winner) because:
 *   1. Renderers want to enumerate "N contributors registered".
 *   2. The selector is per-strategy and may inspect all of them.
 *   3. Auto-mounted vs user-supplied is a visibility distinction
 *      consumers need to surface separately. */
type State = ReadonlyMap<string, ReadonlyArray<Entry>>;

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
		const state = yield* Ref.make<State>(new Map());
		const seqRef = yield* Ref.make(0);

		const register: StrategyRegistry['register'] = <Key extends string, S>(
			key: Key,
			strategy: S,
			options?: { readonly autoMounted?: boolean; readonly priority?: number },
		) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				const entry: Entry = {
					strategy,
					autoMounted: options?.autoMounted ?? false,
					priority: options?.priority ?? 0,
					seq,
				};
				yield* Ref.update(state, (current) => {
					const existing = current.get(key) ?? [];
					const next = new Map(current);
					next.set(key, [...existing, entry]);
					return next;
				});
				// Scope finalizer: drop this entry on scope close.
				// Sequence-number match makes parallel registrations
				// safe — we only drop the entry we added.
				yield* Effect.addFinalizer((_exit) =>
					Ref.update(state, (current) => {
						const existing = current.get(key);
						if (!existing) return current;
						const filtered = existing.filter((e) => e.seq !== seq);
						const next = new Map(current);
						if (filtered.length === 0) next.delete(key);
						else next.set(key, filtered);
						return next;
					}),
				);
				yield* Effect.annotateCurrentSpan({
					'strategy.key': key,
					'strategy.autoMounted': entry.autoMounted,
				});
			}).pipe(Effect.withSpan('substrate.strategyRegistry.register')) as Effect.Effect<
				void,
				never,
				Scope.Scope
			>;

		const get: StrategyRegistry['get'] = <Key extends string, S>(key: Key) =>
			Effect.gen(function* () {
				const current = yield* Ref.get(state);
				const entries = current.get(key);
				if (!entries || entries.length === 0) {
					return yield* new StrategyNotFoundError({
						capabilityKey: key,
						registeredKeys: [...current.keys()],
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
					if (e.priority > best.priority || (e.priority === best.priority && e.seq > best.seq)) {
						best = e;
					}
				}
				return best.strategy as S;
			}).pipe(Effect.withSpan('substrate.strategyRegistry.get', { attributes: { key } }));

		const list: StrategyRegistry['list'] = () =>
			Effect.gen(function* () {
				const current = yield* Ref.get(state);
				return [...current.keys()];
			});

		return StrategyRegistryService.of({
			get: get as StrategyRegistry['get'],
			register: register as StrategyRegistry['register'],
			list,
		});
	}),
);
