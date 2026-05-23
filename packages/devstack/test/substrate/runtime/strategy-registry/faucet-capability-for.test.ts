// `faucetCapabilityFor` — strategy-registry sugar for faucet-strategy
// lookups.
//
// Invariants under test:
//   1. Lookup succeeds when a faucet strategy is registered under
//      `faucet:request:<chainId>` — returns the registered value
//      verbatim.
//   2. Lookup fails with `StrategyNotFoundError` when no strategy is
//      registered — preserves the substrate registry contract so call
//      sites can project to plugin-flavored errors.
//   3. Two chains each return their own registered strategy (capability
//      keys disambiguate per-chain populations).

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { chainId } from '../../../../src/substrate/brand.ts';
import {
	StrategyRegistryService,
	faucetCapabilityFor,
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

describe('faucetCapabilityFor', () => {
	it.effect('returns the strategy registered under the faucet capability key', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chain = chainId('sui:localnet');
				const strategy = stubStrategy();
				yield* registry.register(`faucet:request:${chain}`, strategy);

				const resolved = yield* faucetCapabilityFor<StubStrategy>(chain);
				expect(resolved).toBe(strategy);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('fails with StrategyNotFoundError when no strategy is registered', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const chain = chainId('sui:absent');
				const exit = yield* Effect.exit(faucetCapabilityFor<StubStrategy>(chain));
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					expect(err.value._tag).toBe('StrategyNotFoundError');
					expect(err.value.capabilityKey).toBe(`faucet:request:${chain}`);
				}
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('two chains: each returns its own registered strategy', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chainA = chainId('sui:a');
				const chainB = chainId('sui:b');
				const stratA = stubStrategy();
				const stratB = stubStrategy();
				yield* registry.register(`faucet:request:${chainA}`, stratA);
				yield* registry.register(`faucet:request:${chainB}`, stratB);

				expect(yield* faucetCapabilityFor<StubStrategy>(chainA)).toBe(stratA);
				expect(yield* faucetCapabilityFor<StubStrategy>(chainB)).toBe(stratB);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);
});
