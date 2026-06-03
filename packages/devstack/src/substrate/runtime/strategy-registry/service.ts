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

import { Context, Effect, Layer, Scope } from 'effect';

import type { StrategyRegistry } from '../../../contracts/strategy-contributor.ts';
import { StrategyNotFoundError } from '../errors.ts';
import { SpanAttr } from '../observability/spans.ts';
import { makeScopedMultimap } from '../scoped-registry/index.ts';

/** One registered strategy under a capability key. The multimap stamps
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
		const store = yield* makeScopedMultimap<string, Entry>();

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
				// The multimap stamps the seq and wires the drop-by-seq
				// finalizer — parallel registrations stay isolated.
				yield* store.register([{ key, value: entry }]);
				yield* Effect.annotateCurrentSpan({
					[SpanAttr.strategyKey]: key,
					[SpanAttr.strategyAutoMounted]: entry.autoMounted,
				});
			}).pipe(Effect.withSpan('substrate.strategyRegistry.register')) as Effect.Effect<
				void,
				never,
				Scope.Scope
			>;

		const get: StrategyRegistry['get'] = <Key extends string, S>(key: Key) =>
			Effect.gen(function* () {
				const entries = yield* store.entriesFor(key);
				if (entries.length === 0) {
					const keys = yield* store.keys;
					return yield* new StrategyNotFoundError({
						capabilityKey: key,
						registeredKeys: keys,
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
			}).pipe(Effect.withSpan('substrate.strategyRegistry.get', { attributes: { key } }));

		const list: StrategyRegistry['list'] = () => store.keys;

		return StrategyRegistryService.of({
			get: get as StrategyRegistry['get'],
			register: register as StrategyRegistry['register'],
			list,
		});
	}),
);
