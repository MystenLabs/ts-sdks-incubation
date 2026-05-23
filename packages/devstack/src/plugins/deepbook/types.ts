// Deepbook plugin — public user-facing types.
//
// This file declares the DeepBook resolved-value and helper shapes.
// The local factory in `index.ts` only accepts options that acquire
// real behavior in the current implementation.
//
// Substrate-blindness rule: nothing here references a specific
// account / coin / package member's resolved value — the references
// flow in as Direct Member Refs (the locked Decision per
// `feedback_no_inline_validation_in_parallel_agents` /
// `project_devstack_api_design_locked_decisions`).

import type { AccountValue } from '../account/index.ts';
import type { CoinValue } from '../coin/index.ts';
import type { LocalPackageResolved } from '../package/index.ts';
import type { ResourceRef } from '../../api/define-plugin.ts';

// ---------------------------------------------------------------------------
// Pyth — internal sub-module shapes (NOT a top-level plugin per memory
// `project_pyth_inside_deepbook`).
// ---------------------------------------------------------------------------

/** A Pyth price feed id — opaque 64-character hex string. */
export type PythPriceFeedId = string & { readonly __pythPriceFeedId: unique symbol };

export const pythPriceFeedId = (s: string): PythPriceFeedId => s as PythPriceFeedId;

/** Pyth feed binding — symbol + feed id + initial price. */
export interface PythFeed {
	readonly symbol: string;
	readonly feedId: PythPriceFeedId;
	/** Initial price expressed in feed-native scale (Pyth conf is the
	 *  signed-int representation; bigint avoids float precision drift). */
	readonly initialPrice: bigint;
	/** Feed exponent. Defaults to -8, matching the DeepBook sandbox. */
	readonly expo?: number;
	/** Optional confidence interval. Defaults to 0 for deterministic local feeds. */
	readonly confidence?: bigint;
	/** Optional EMA price. Defaults to `initialPrice`. */
	readonly emaPrice?: bigint;
}

/** Pyth options. `package` and `pusher` are member refs, not magic strings. */
export interface PythOptions<
	Package extends PythPackageMember = PythPackageMember,
	Pusher extends AccountMemberAlias = AccountMemberAlias,
> {
	readonly package: Package;
	readonly pusher: Pusher;
	readonly feeds: ReadonlyArray<PythFeed>;
}

/** Resolved Pyth handle exposed inside the deepbook resolved value. */
export interface PythHandle {
	/** Local sandbox Pyth has no Wormhole state; known deployments do. */
	readonly packageId: string | null;
	readonly stateId: string | null;
	readonly wormholeStateId: string | null;
	readonly feeds: ReadonlyArray<{
		readonly symbol: string;
		readonly feedId: PythPriceFeedId;
		readonly priceInfoObjectId: string;
		readonly price: bigint;
		readonly expo: number;
	}>;
}

/** Common Pyth price feed ids (subset; users pass their own as
 *  needed). These are the well-known Pyth hex feed ids, NOT
 *  per-stack derived. */
export const SUI_PRICE_FEED_ID: PythPriceFeedId = pythPriceFeedId(
	'23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
);
export const USDC_PRICE_FEED_ID: PythPriceFeedId = pythPriceFeedId(
	'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
);
export const DEEP_PRICE_FEED_ID: PythPriceFeedId = pythPriceFeedId(
	'29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff',
);

// ---------------------------------------------------------------------------
// Pool spec
// ---------------------------------------------------------------------------

/** Coin handle used by local DeepBook pool specs. `key` is the SDK-facing
 *  coin key (for example `DEEP` or `SUI`); `coin` is the devstack member ref
 *  whose resolved value supplies the full Move coin type. */
export interface DeepbookPoolCoin<Coin extends CoinMemberAlias = CoinMemberAlias> {
	readonly key: string;
	readonly coin: Coin;
	/** SDK scalar for this coin. Defaults to the resolved coin decimals. */
	readonly scalar?: number;
	/** SDK address column. Defaults to the package id for package coins, or
	 *  the address portion of the resolved full coin type. */
	readonly address?: string;
}

/** Seed order placed after a local pool is created. Price and quantity use
 *  DeepBook's on-chain units: `price` is quote-unit price and `quantity` is
 *  base-asset quantity. */
export interface DeepbookPoolSeedOrder {
	readonly side: 'ask' | 'bid';
	readonly price: bigint;
	readonly quantity: bigint;
	readonly clientOrderId?: bigint;
	readonly payWithDeep?: boolean;
}

/** Optional local liquidity seed. Package coins with a generic funding
 *  strategy are minted to the publisher before the seed transaction; otherwise
 *  the publisher must already own the deposited coins. */
export interface DeepbookPoolSeedLiquidity {
	readonly baseAmount?: bigint;
	readonly quoteAmount?: bigint;
	readonly orders: ReadonlyArray<DeepbookPoolSeedOrder>;
}

/** Whitelisted pool to create at deploy time. `base` / `quote` are real coin
 *  member refs so pool creation cannot race package/coin resolution. */
export interface DeepbookPoolSpec<
	Base extends CoinMemberAlias = CoinMemberAlias,
	Quote extends CoinMemberAlias = CoinMemberAlias,
> {
	readonly name: string;
	readonly base: DeepbookPoolCoin<Base>;
	readonly quote: DeepbookPoolCoin<Quote>;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
	/** Whitelisted? Defaults true for local deploy (no DEEP-burn). */
	readonly whitelisted?: boolean;
	/** Stable pool? Defaults false. */
	readonly stablePool?: boolean;
	/** Optional publisher-owned BalanceManager + seed orders for local demos. */
	readonly seed?: DeepbookPoolSeedLiquidity;
}

/** A resolved pool record on chain. */
export interface DeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly baseCoinType: string;
	readonly quote: string;
	readonly quoteCoinType: string;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

/** Per-asset margin parameters (matches deepbook-v3 margin module). */
export interface DeepbookMarginAssetConfig {
	readonly label: string;
	readonly coinType: string;
	readonly scalar: number;
	readonly feed: PythPriceFeedId;
	readonly maxConfBps: number;
	readonly maxEwmaDifferenceBps: number;
	readonly supplyCap: number;
	readonly maxUtilizationRate: number;
	readonly referralSpread: number;
	readonly minBorrow: number;
	readonly rateLimitCapacity: number;
	readonly rateLimitRefillRatePerMs: number;
	readonly rateLimitEnabled: boolean;
	readonly baseRate: number;
	readonly baseSlope: number;
	readonly optimalUtilization: number;
	readonly excessSlope: number;
}

/** Per-pool risk parameters. */
export interface DeepbookMarginPoolRiskConfig {
	readonly minWithdrawRiskRatio: number;
	readonly minBorrowRiskRatio: number;
	readonly liquidationRiskRatio: number;
	readonly targetLiquidationRiskRatio: number;
	readonly userLiquidationReward: number;
	readonly poolLiquidationReward: number;
}

export interface DeepbookMarginPoolRegistration {
	readonly pool: string;
	readonly risk?: DeepbookMarginPoolRiskConfig;
}

export interface DeepbookMarginOptions {
	readonly assets: ReadonlyArray<
		Omit<DeepbookMarginAssetConfig, 'coinType'> & {
			readonly coinType?: string;
		}
	>;
	readonly pools: ReadonlyArray<DeepbookMarginPoolRegistration>;
	readonly maxAgeSeconds?: bigint;
}

export interface DeepbookMargin {
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly marginPools: ReadonlyArray<{
		readonly label: string;
		readonly coinType: string;
		readonly marginPoolId: string;
	}>;
	readonly registeredPools: ReadonlyArray<string>;
}

/** Sensible defaults for the common assets. The user passes
 *  `{ ...USDC_MARGIN_DEFAULTS, coinType: '0x...::usdc::USDC' }`. */
export const USDC_MARGIN_DEFAULTS: Omit<DeepbookMarginAssetConfig, 'coinType'> = {
	label: 'USDC',
	scalar: 1_000_000,
	feed: USDC_PRICE_FEED_ID,
	maxConfBps: 100,
	maxEwmaDifferenceBps: 500,
	supplyCap: 1_000_000,
	maxUtilizationRate: 0.8,
	referralSpread: 0.2,
	minBorrow: 0.1,
	rateLimitCapacity: 200_000,
	rateLimitRefillRatePerMs: 0.009259,
	rateLimitEnabled: true,
	baseRate: 0.1,
	baseSlope: 0.15,
	optimalUtilization: 0.8,
	excessSlope: 5,
};

export const SUI_MARGIN_DEFAULTS: Omit<DeepbookMarginAssetConfig, 'coinType'> = {
	label: 'SUI',
	scalar: 1_000_000_000,
	feed: SUI_PRICE_FEED_ID,
	maxConfBps: 300,
	maxEwmaDifferenceBps: 1500,
	supplyCap: 500_000,
	maxUtilizationRate: 0.8,
	referralSpread: 0.2,
	minBorrow: 0.1,
	rateLimitCapacity: 100_000,
	rateLimitRefillRatePerMs: 0.00462963,
	rateLimitEnabled: true,
	baseRate: 0.1,
	baseSlope: 0.2,
	optimalUtilization: 0.8,
	excessSlope: 5,
};

export const DEFAULT_POOL_RISK_CONFIG: DeepbookMarginPoolRiskConfig = {
	minWithdrawRiskRatio: 2,
	minBorrowRiskRatio: 1.2499,
	liquidationRiskRatio: 1.1,
	targetLiquidationRiskRatio: 1.25,
	userLiquidationReward: 0.02,
	poolLiquidationReward: 0.03,
};

// ---------------------------------------------------------------------------
// Market maker
// ---------------------------------------------------------------------------

/** Strategy descriptor — narrow union; deepbook bps-grid is the
 *  reference. */
export type DeepbookMarketMakerStrategy = {
	readonly kind: 'bps';
	readonly spreadBps: number;
	readonly levelSpacingBps: number;
	readonly levels: number;
};

export interface DeepbookMarketMakerOptions {
	readonly signer: AccountMemberAlias;
	readonly strategy: DeepbookMarketMakerStrategy;
	/** Optional cadence; defaults to 5s. */
	readonly tickIntervalMillis?: number;
	/** Optional pool filter; defaults to all pools. */
	readonly pools?: ReadonlyArray<string>;
}

export interface DeepbookMarketMaker {
	readonly signer: string;
	readonly running: boolean;
	readonly pools: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Member ref aliases — Direct Member Refs surface (locked API decision)
// ---------------------------------------------------------------------------

/** Account ref alias — the user passes the value returned by
 *  `account('name')`. Resource-typed at the factory boundary so a
 *  package-shaped ref is a TS error while preserving the literal
 *  `account/<name>` id. */
export type AccountMemberAlias<Name extends string = string> = ResourceRef<
	`account/${Name}`,
	AccountValue
>;

/** Coin ref alias — the user passes `coin.fromPackage(...)`, `coin.known(...)`,
 *  or `coin.builtin(...)`. */
export type CoinMemberAlias<Name extends string = string> = ResourceRef<`coin:${Name}`, CoinValue>;

/** Local package ref alias for the published DeepBook package. The package
 *  should capture `registryId` and `adminCapId` from its publish output. */
export type DeepbookPackageMember<Name extends string = string> = ResourceRef<
	`package:${Name}`,
	LocalPackageResolved
>;

/** Local package ref alias for the mock Pyth package used by local DeepBook. */
export type PythPackageMember<Name extends string = string> = ResourceRef<
	`package:${Name}`,
	LocalPackageResolved
>;
