// `faucetCapabilityFor` — strategy-registry sugar for the faucet
// capability lookup. Mirrors `chainProbeFor`.
//
// Plugins that fund addresses (account default funding, account
// cross-cutting funding, the faucet dispatcher itself) repeat the
// same 4-line dance: yield the StrategyRegistryService, build the
// `faucet:request:<chainId>` key, then `registry.get<typeof key, P>(key)`
// with the same trailing cast. Centralised here so call sites stop
// repeating it.
//
// The substrate stays name-blind: the strategy shape `P` is a free
// generic (the faucet plugin owns the `FaucetStrategy` contract;
// callers pass it as the type argument). Returned cast threads
// through the registry's `unknown` payload at one site only.

import { Effect } from 'effect';

import type { StrategyNotFoundError } from '../../../contracts/strategy-contributor.ts';
import type { ChainId } from '../../brand.ts';
import { StrategyRegistryService } from './service.ts';

/** Capability-key prefix for faucet-request strategies. The full key is
 *  `faucet:request:<chainId>`. Duplicated from the faucet plugin's
 *  `dispatcher.ts` so the substrate helper stays plugin-free; the two
 *  constants are checked for agreement by the migrated call sites at
 *  typecheck time (they import the helper, not the prefix). */
const FAUCET_CAPABILITY_KEY_PREFIX = 'faucet:request' as const;

const faucetCapabilityKey = (
	chainId: ChainId,
): `${typeof FAUCET_CAPABILITY_KEY_PREFIX}:${string}` =>
	`${FAUCET_CAPABILITY_KEY_PREFIX}:${chainId}`;

/**
 * Look up the faucet strategy contributed for the given chain id and
 * surface it with the caller's expected shape.
 *
 * The strategy shape `P` is a free generic — the faucet plugin owns
 * the `FaucetStrategy` contract, callers pass it at the call site
 * (`faucetCapabilityFor<FaucetStrategy>(chainId)`). Failure shape is
 * the substrate `StrategyNotFoundError`; callers that want a
 * plugin-flavored error project it via `Effect.catchTag` at the call
 * site.
 */
export const faucetCapabilityFor = <P>(
	chainId: ChainId,
): Effect.Effect<P, StrategyNotFoundError, StrategyRegistryService> =>
	Effect.gen(function* () {
		const registry = yield* StrategyRegistryService;
		const key = faucetCapabilityKey(chainId);
		return yield* registry.get<typeof key, P>(key);
	});
