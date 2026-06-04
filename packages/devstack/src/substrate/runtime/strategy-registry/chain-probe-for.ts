// `chainProbeFor` — strategy-registry sugar for the chain-probe lookup.
//
// Every plugin that produces an on-chain artifact (package, coin, seal,
// walrus, action, ...) repeats the same 4-line dance: yield the
// StrategyRegistryService, then `registry.get<...>(chainProbeCapabilityKey(chain))`
// with the same generic args and the same trailing cast. The dance is
// load-bearing exactly once (the cast threads `SuiProbeKey` through the
// capability-key's `string` discriminator) — every other site is
// boilerplate.
//
// This helper consolidates the pattern: one Effect, one R-channel
// (`StrategyRegistryService`), one typed return (`ChainProbe<Key>`).
// Call sites become a single `yield* chainProbeFor(sui.chain)`.

import { Effect } from 'effect';

import { chainProbeCapabilityKey, type ChainProbe } from '../../../contracts/chain-probe.ts';
import type { StrategyNotFoundError } from '../errors.ts';
import { StrategyRegistryService } from './service.ts';

/**
 * Look up the chain-probe contributed by the chain owner (Sui's
 * `acquire` registers one per resolved chain id) and surface it with
 * the caller's expected key shape.
 *
 * `Key` defaults to `unknown` so call sites that don't care about the
 * probe key shape can omit the generic; sites that consume Sui probes
 * pass `SuiProbeKey` explicitly. The cast from the registry's
 * `unknown` payload to `ChainProbe<Key>` is centralised here — call
 * sites stop repeating it.
 */
export const chainProbeFor = <Key = unknown>(
	chain: string,
): Effect.Effect<ChainProbe<Key>, StrategyNotFoundError, StrategyRegistryService> =>
	Effect.gen(function* () {
		const registry = yield* StrategyRegistryService;
		const probe = yield* registry.get<`chain-probe:${string}`, ChainProbe<Key>>(
			chainProbeCapabilityKey(chain),
		);
		return probe;
	});
