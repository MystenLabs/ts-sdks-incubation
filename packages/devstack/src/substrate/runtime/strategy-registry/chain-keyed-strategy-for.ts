// `chainKeyedStrategyFor` — strategy-registry sugar for chain-keyed
// strategy lookups. Mirrors `chainProbeFor`.
//
// The substrate is name-blind: the caller passes both the prefix and
// the chain id, and the helper assembles `<prefix>:<chainId>` and
// performs the registry lookup. The faucet plugin's
// `FAUCET_CAPABILITY_KEY_PREFIX` is the single source of truth for the
// faucet key shape; the substrate does NOT duplicate it.

import { Effect } from 'effect';

import type { StrategyNotFoundError } from '../errors.ts';
import { StrategyRegistryService } from './service.ts';

/**
 * Look up the strategy registered under `<prefix>:<chainId>` and surface
 * it with the caller's expected shape.
 *
 * The strategy shape `P` is a free generic — the plugin that owns the
 * capability prefix also owns its strategy contract, and callers pass
 * both at the call site:
 *
 * ```ts
 * import { FAUCET_CAPABILITY_KEY_PREFIX, type FaucetStrategy } from '../faucet/index.ts';
 *
 * const strategy = yield* chainKeyedStrategyFor<FaucetStrategy>(
 *   FAUCET_CAPABILITY_KEY_PREFIX,
 *   parts.chainId,
 * );
 * ```
 *
 * Failure shape is the substrate `StrategyNotFoundError`; callers that
 * want a plugin-flavored error project it via `Effect.catchTag` at the
 * call site.
 */
export const chainKeyedStrategyFor = <P>(
	prefix: string,
	chainId: string,
): Effect.Effect<P, StrategyNotFoundError, StrategyRegistryService> =>
	Effect.gen(function* () {
		const registry = yield* StrategyRegistryService;
		const key = `${prefix}:${chainId}`;
		return yield* registry.get<typeof key, P>(key);
	});
