// `chainKeyedStrategyFor` — strategy-registry sugar for chain-keyed
// strategy lookups.
//
// Invariants under test:
//   1. Lookup succeeds when a strategy is registered under
//      `<prefix>:<chainId>` — returns the registered value verbatim.
//   2. Lookup fails with `StrategyNotFoundError` when no strategy is
//      registered — preserves the substrate registry contract so call
//      sites can project to plugin-flavored errors.
//   3. Two chains each return their own registered strategy (capability
//      keys disambiguate per-chain populations).
//   4. Two prefixes do not cross-talk (the substrate is name-blind —
//      it treats the prefix as opaque).

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	StrategyRegistryService,
	chainKeyedStrategyFor,
	layerStrategyRegistry,
} from '../../../../src/substrate/runtime/strategy-registry/index.ts';

interface StubStrategy {
	readonly request: (req: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void>;
}

const stubStrategy = (): StubStrategy => ({
	request: () => Effect.void,
});

const FAUCET_PREFIX = 'faucet:request';

describe('chainKeyedStrategyFor', () => {
	it.effect('returns the strategy registered under <prefix>:<chainId>', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chain = 'sui:localnet';
				const strategy = stubStrategy();
				yield* registry.register(`${FAUCET_PREFIX}:${chain}`, strategy);

				const resolved = yield* chainKeyedStrategyFor<StubStrategy>(FAUCET_PREFIX, chain);
				expect(resolved).toBe(strategy);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('fails with StrategyNotFoundError when no strategy is registered', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const chain = 'sui:absent';
				const exit = yield* Effect.exit(chainKeyedStrategyFor<StubStrategy>(FAUCET_PREFIX, chain));
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					expect(err.value._tag).toBe('StrategyNotFoundError');
					expect(err.value.capabilityKey).toBe(`${FAUCET_PREFIX}:${chain}`);
				}
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('two chains: each returns its own registered strategy', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chainA = 'sui:a';
				const chainB = 'sui:b';
				const stratA = stubStrategy();
				const stratB = stubStrategy();
				yield* registry.register(`${FAUCET_PREFIX}:${chainA}`, stratA);
				yield* registry.register(`${FAUCET_PREFIX}:${chainB}`, stratB);

				expect(yield* chainKeyedStrategyFor<StubStrategy>(FAUCET_PREFIX, chainA)).toBe(stratA);
				expect(yield* chainKeyedStrategyFor<StubStrategy>(FAUCET_PREFIX, chainB)).toBe(stratB);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('two prefixes: substrate is name-blind, prefixes do not cross-talk', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chain = 'sui:localnet';
				const faucetStrategy = stubStrategy();
				const customStrategy = stubStrategy();
				yield* registry.register(`${FAUCET_PREFIX}:${chain}`, faucetStrategy);
				yield* registry.register(`custom:prefix:${chain}`, customStrategy);

				expect(yield* chainKeyedStrategyFor<StubStrategy>(FAUCET_PREFIX, chain)).toBe(
					faucetStrategy,
				);
				expect(yield* chainKeyedStrategyFor<StubStrategy>('custom:prefix', chain)).toBe(
					customStrategy,
				);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);
});
