// Faucet plugin — acquire procedure.
//
// Architecture (distilled doc §Lifecycle states):
//   - Constructed: the strategy registry already exists at the
//     scope (built by the substrate's `layerStrategyRegistry`). The
//     faucet plugin doesn't OWN the registry — it CONSUMES it.
//   - Built-in populated: when the plugin's own auto-mode (driven by
//     the Sui mode it observes via tag context) maps to a faucet-
//     bearing chain, the plugin registers a built-in strategy
//     against the chain id. The Sui plugin DOES NOT register the
//     faucet strategy itself — that lives here so the faucet plugin
//     remains the single owner of "how to fund SUI on chain X".
//   - User-populated: caller-supplied strategies from the factory's
//     `strategies` option register after the built-in. Last write
//     wins (priority + seq, in the substrate's registry).
//   - Dispatching: the resolved value carries the dispatcher; sibling
//     plugins (Account, etc.) call `dispatcher.request(...)`.
//   - Teardown: the substrate's registry has a per-entry finalizer;
//     when this plugin's scope closes, the entries it registered are
//     dropped. The plugin holds no other state.
//
// IMPORTANT — registry consumption:
//   The substrate's `StrategyRegistryService` is provided as a
//   service in the scope-local layer (`runtime/strategy-registry`).
//   The plugin acquire yields the service to register + read.

import { Effect, type Scope } from 'effect';

import { StrategyRegistryService } from '../../substrate/runtime/strategy-registry/service.ts';
import { faucetCapabilityKey, makeDispatcher, type FaucetDispatcher } from './dispatcher.ts';
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
	/** Caller-supplied strategies. Registered AFTER the built-in (if
	 *  any), at priority `1` by default — overrides built-ins for
	 *  overlapping chain ids. */
	readonly strategies?: ReadonlyArray<FaucetStrategyContribution>;
}

/** The plugin's resolved-value shape. Exposed via the plugin's
 *  identity tag. */
export interface FaucetService {
	readonly dispatcher: FaucetDispatcher;
}

/**
 * Plugin acquire body. Constructs the dispatcher closure over the
 * scope-local strategy registry and registers any caller-supplied
 * strategies.
 *
 * Architecture: the Sui→Faucet auto-registration runs on the SUI
 * side (Sui's acquire body yields the `StrategyRegistryService` and
 * registers its own `faucet:request:<chainId>` strategy once the
 * resolved faucet URL is known). The faucet plugin therefore makes
 * no assumptions about Sui — it just builds the dispatcher closure
 * over the registry.
 */
export const acquireFaucetService = (
	opts: FaucetServiceOptions,
): Effect.Effect<FaucetService, never, StrategyRegistryService | Scope.Scope> =>
	Effect.gen(function* () {
		const registry = yield* StrategyRegistryService;

		// Caller-supplied strategies. The Sui plugin's own auto-
		// registration runs separately (out-of-band, last-write-wins
		// on tie via the registry's seq counter).
		for (const contribution of opts.strategies ?? []) {
			yield* registry.register(faucetCapabilityKey(contribution.chainId), contribution.strategy, {
				autoMounted: false,
				priority: contribution.priority ?? 1,
			});
		}

		return {
			dispatcher: makeDispatcher(registry),
		};
	}).pipe(Effect.withSpan('faucet.acquire'));
