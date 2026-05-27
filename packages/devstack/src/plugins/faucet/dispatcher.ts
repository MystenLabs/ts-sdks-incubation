// Faucet capability-key encoding + dispatch contract.
//
// Architecture (distilled doc §Selection rule): the faucet plugin's
// substrate-side dispatch is by capability key only — `faucet:request:<chainId>`.
// The chain id is the substrate-level `NetworkConfig.chain` value
// (e.g. `'sui:localnet'`, `'sui:testnet'`, `'sui:mainnet-fork@123'`).
//
// Sibling plugins (currently `sui`) reach in for `faucetCapabilityKey`
// to register a faucet strategy keyed by chain id. The previous
// `FaucetDispatcher` / `makeDispatcher` shape was a dead acquire-time
// closure with no callers; the substrate-level
// `substrate/runtime/strategy-registry/faucet-capability-for.ts` is the
// canonical lookup helper now.
//
// The `FaucetStrategy` interface is the dispatch shape — it lives in
// the faucet plugin because the faucet plugin OWNS the dispatcher.
// Strategy implementations (sui-local, future user strategies) close
// over their own wire surface and satisfy this shape; the dispatcher
// is implementation-blind.

import type { Effect } from 'effect';

import type { FaucetBodyError, FaucetExhausted, FaucetUnreachable } from './errors.ts';

/** Capability key prefix for a faucet request strategy. The full
 *  key is `faucet:request:<chainId>`. */
export const FAUCET_CAPABILITY_KEY_PREFIX = 'faucet:request' as const;

/** Build the full capability key for a chain. Literal-typed so the
 *  downstream `StrategyFor<Caps, Key>` lookup picks the strategy
 *  shape out of a tuple by name. */
export const faucetCapabilityKey = <ChainId extends string>(
	chainId: ChainId,
): `${typeof FAUCET_CAPABILITY_KEY_PREFIX}:${ChainId}` =>
	`${FAUCET_CAPABILITY_KEY_PREFIX}:${chainId}` as const;

/**
 * Faucet strategy value. The dispatch surface is uniform across
 * strategies — the dispatcher doesn't know how a strategy delivers
 * coins, only how to invoke it.
 *
 * `amount` is the chain-native smallest unit (MIST for SUI). Some
 * backends (the local sui-faucet binary) grant a fixed amount per
 * request and IGNORE this value; the parameter is here for type
 * uniformity and to land correctly-denominated values in
 * `FaucetExhausted`.
 */
export interface FaucetStrategy {
	readonly request: (req: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void, FaucetExhausted | FaucetUnreachable | FaucetBodyError>;
}
