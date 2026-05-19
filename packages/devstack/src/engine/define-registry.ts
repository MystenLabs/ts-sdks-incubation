// `defineRegistry` — one declaration produces the
// `{Tag, Live, publish, require, snapshot}` quintuple every devstack
// registry exposes. Replaces the per-registry trio boilerplate (class +
// Layer.effect + `publish*` wrapper) that the engine accreted as each
// new service needed its own pub/sub bus.
//
// The trade-off the cookbook accepts: per-call type narrowing degrades
// slightly because every registry routes through one generic factory.
// Tree-shaking is irrelevant for a devtool that always runs as one
// process; the legibility win (one site per registry instead of three)
// dominates.
//
// Behavioural contract — append-only `Ref<ReadonlyArray<T>>`, last-write
// wins on dedupe-by-name, no IO. Matches the pre-factory shape exactly
// so the existing call sites move with no semantic change.

import { Context, Effect, Layer, Ref as EffectRef } from 'effect';
import type { LayeredTag, TagIdentity } from '../advanced/tag.js';

/** Shape every registry exposes. `register` is append-only; `snapshot`
 *  returns the current array. Consumers fold their dedupe-by-name pass
 *  on top of `snapshot` (e.g. `gatherManifest` last-writes-win). */
export interface RegistryShape<T> {
	readonly register: (entry: T) => Effect.Effect<void>;
	readonly snapshot: Effect.Effect<ReadonlyArray<T>>;
}

/** Build the live registry. Append-only `Ref<ReadonlyArray<T>>`. Shared
 *  factory so `defineRegistry` and (where they still exist) hand-rolled
 *  Live layers compose identically — the `EndpointRegistry` flavor that
 *  also touches `EngineHandle` in `engine/engine.ts` calls this helper
 *  rather than re-implementing the Ref dance. */
export const makeRegistryLive = <T>() =>
	Effect.gen(function* () {
		const ref = yield* EffectRef.make<ReadonlyArray<T>>([]);
		return {
			register: (entry: T) => EffectRef.update(ref, (xs) => [...xs, entry]),
			snapshot: EffectRef.get(ref),
		} satisfies RegistryShape<T>;
	});

/** Define the `{Live, publish, require}` triple for a registry whose
 *  `Tag` is declared at the call site:
 *
 *  ```ts
 *  export class CoinRegistry extends Context.Service<CoinRegistry, RegistryShape<CoinRecord>>()(
 *    '@devstack/CoinRegistry',
 *  ) {}
 *  export const { Live: CoinRegistryLive, publish: publishCoin, require: requireCoinRegistry } =
 *    defineRegistry<CoinRegistry, CoinRecord>(CoinRegistry);
 *  ```
 *
 *  The class declaration stays at the call site so identity narrows to
 *  the canonical name (`yield* CoinRegistry` produces `RegistryShape<CoinRecord>`,
 *  not `RegistryShape<unknown>`). The factory absorbs the per-registry
 *  boilerplate without taking that legibility away. */
export const defineRegistry = <I, T>(
	Tag: Context.Service<I, RegistryShape<T>>,
): {
	readonly Live: Layer.Layer<I>;
	readonly publish: (entry: T) => Effect.Effect<void, never, I>;
	readonly require: <Name extends string, A, R, E>(
		tag: LayeredTag<Name, A, R, E>,
	) => Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>;
} => {
	const Live = Layer.effect(Tag, makeRegistryLive<T>());

	const publish = (entry: T): Effect.Effect<void, never, I> =>
		Effect.gen(function* () {
			const reg = yield* Tag;
			yield* reg.register(entry);
		});

	const require = <Name extends string, A, R, E>(
		tag: LayeredTag<Name, A, R, E>,
	): Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I> =>
		Effect.gen(function* () {
			yield* tag;
			return yield* Tag;
		}) as Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>;

	return { Live, publish, require };
};
