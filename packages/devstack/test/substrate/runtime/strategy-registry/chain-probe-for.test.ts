// `chainProbeFor` — strategy-registry sugar for chain-probe lookups.
//
// Invariants under test:
//   1. Lookup succeeds when a chain-probe has been registered for the
//      requested chain — returns the registered probe verbatim.
//   2. Lookup fails with `StrategyNotFoundError` when no chain-probe is
//      registered for the chain (matches the underlying
//      `StrategyRegistry.get` contract).
//   3. The capability key is constructed via `chainProbeCapabilityKey` —
//      i.e. a probe registered manually under that key surfaces through
//      `chainProbeFor`.

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { chainProbeCapabilityKey, type ChainProbe } from '../../../../src/contracts/chain-probe.ts';
import {
	StrategyRegistryService,
	chainProbeFor,
	layerStrategyRegistry,
} from '../../../../src/substrate/runtime/strategy-registry/index.ts';

type StubKey = `0x${string}::stub::Key`;

const stubProbe = (): ChainProbe<StubKey> => ({
	get: () => Effect.succeed(null),
});

describe('chainProbeFor', () => {
	it.effect('returns the probe registered under the chain-probe capability key', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chain = 'sui:localnet';
				const probe = stubProbe();
				yield* registry.register(chainProbeCapabilityKey(chain), probe);

				const resolved = yield* chainProbeFor<StubKey>(chain);
				expect(resolved).toBe(probe);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('fails with StrategyNotFoundError when no probe is registered', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const chain = 'sui:absent';
				const exit = yield* Effect.exit(chainProbeFor<StubKey>(chain));
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					expect(err.value._tag).toBe('StrategyNotFoundError');
					expect(err.value.capabilityKey).toBe(chainProbeCapabilityKey(chain));
				}
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);

	it.effect('two chains: each returns its own registered probe', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* StrategyRegistryService;
				const chainA = 'sui:a';
				const chainB = 'sui:b';
				const probeA = stubProbe();
				const probeB = stubProbe();
				yield* registry.register(chainProbeCapabilityKey(chainA), probeA);
				yield* registry.register(chainProbeCapabilityKey(chainB), probeB);

				expect(yield* chainProbeFor<StubKey>(chainA)).toBe(probeA);
				expect(yield* chainProbeFor<StubKey>(chainB)).toBe(probeB);
			}),
		).pipe(Effect.provide(layerStrategyRegistry)),
	);
});
