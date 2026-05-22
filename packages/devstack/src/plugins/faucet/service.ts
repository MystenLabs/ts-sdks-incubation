// Faucet plugin — acquire procedure.
//
// Architecture (distilled doc §Lifecycle states):
//   - Constructed: the strategy registry already exists at the
//     scope (built by the substrate's `layerStrategyRegistry`). The
//     faucet plugin doesn't OWN the registry — it CONSUMES it.
//   - Populated: strategy-contributor capabilities register
//     per-chain faucet strategies in the substrate's generic
//     strategy registry.
//   - Dispatching: the resolved value carries the dispatcher; sibling
//     plugins (Account, etc.) call `dispatcher.request(...)`.
//   - Teardown: the substrate's registry has a per-entry finalizer;
//     when a contributing plugin's scope closes, the entries it
//     registered are dropped. The faucet plugin holds no other state.
//
// IMPORTANT — registry consumption:
//   The substrate's `StrategyRegistryService` is provided as a
//   service in the scope-local layer (`runtime/strategy-registry`).
//   The plugin acquire yields the service to build the dispatcher.

import { Effect } from 'effect';

import { StrategyRegistryService } from '../../substrate/runtime/strategy-registry/service.ts';
import { makeDispatcher, type FaucetDispatcher } from './dispatcher.ts';
import type { FaucetStrategy } from './strategies/sui-local.ts';

/** A registered strategy contribution. The faucet plugin accepts
 *  these from the factory's options so callers can add per-chain
 *  faucets (custom fork admins, alt-network strategies) without
 *  authoring a sibling plugin. */
export interface FaucetStrategyContribution {
	/** Capability-key chain id (`'sui:localnet'`, `'sui:testnet'`, etc.). */
	readonly chainId: string;
	/** The strategy value — closes over its own dependencies. */
	readonly strategy: FaucetStrategy;
	/** Optional priority. Defaults to `1` so user strategies win
	 *  over the built-in's `0`. */
	readonly priority?: number;
}

/** Factory options. */
export interface FaucetServiceOptions {
	/** Caller-supplied strategies. The faucet factory converts these
	 *  into strategy-contributor capabilities, at priority `1` by
	 *  default so they override built-ins for overlapping chain ids. */
	readonly strategies?: ReadonlyArray<FaucetStrategyContribution>;
}

/** The plugin's resolved-value shape. Exposed via the plugin's
 *  identity tag. */
export interface FaucetService {
	readonly dispatcher: FaucetDispatcher;
}

/**
 * Plugin acquire body. Constructs the dispatcher closure over the
 * scope-local strategy registry.
 */
export const acquireFaucetService = (
	_opts: FaucetServiceOptions,
): Effect.Effect<FaucetService, never, StrategyRegistryService> =>
	Effect.gen(function* () {
		const registry = yield* StrategyRegistryService;

		return {
			dispatcher: makeDispatcher(registry),
		};
	}).pipe(Effect.withSpan('faucet.acquire'));
