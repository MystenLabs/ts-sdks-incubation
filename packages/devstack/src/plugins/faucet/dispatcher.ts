// Faucet capability-key encoding.
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
// canonical lookup helper now (pending the Phase 5 name-blindness
// generalisation to `chainKeyedStrategyFor(prefix, key)`).

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
