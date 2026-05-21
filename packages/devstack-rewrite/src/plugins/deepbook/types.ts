// Deepbook plugin — public user-facing types.
//
// Per `api-surface-design.md` §8 Example 5: the deepbook composite
// accepts a pool list with symbolic `base` / `quote` strings, an
// optional pyth feed list, an optional margin block, an optional
// market-maker block. This file declares those shape types; the
// composite factory in `index.ts` consumes them.
//
// Substrate-blindness rule: nothing here references a specific
// account / coin / package member's resolved value — the references
// flow in as Direct Member Refs (the locked Decision per
// `feedback_no_inline_validation_in_parallel_agents` /
// `project_devstack_api_design_locked_decisions`).

import type { AccountValue } from '../account/index.ts';
import type { ResolvedPackage } from '../package/index.ts';
import type { CapabilityDecl } from '../../contracts/capability-decl.ts';
import type { LiftedSiblingKey } from '../../substrate/lifted-sibling.ts';
import type { StackMember } from '../../substrate/plugin.ts';
import type { AnyTag, Tag } from '../../substrate/tag.ts';

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
}

/** Pyth options — what the user threads through `deepbook({pyth})`.
 *  `pusher` is an account MEMBER ref (direct ref, not magic string). */
export interface PythOptions {
	readonly pusher: AccountMemberAlias;
	readonly feeds: ReadonlyArray<PythFeed>;
}

/** Resolved Pyth handle exposed inside the deepbook resolved value. */
export interface PythHandle {
	readonly stateId: string;
	readonly wormholeStateId: string;
	readonly feeds: ReadonlyArray<{
		readonly symbol: string;
		readonly feedId: PythPriceFeedId;
		readonly priceInfoObjectId: string;
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
	'29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6375802',
);

// ---------------------------------------------------------------------------
// Pool spec
// ---------------------------------------------------------------------------

/** Whitelisted pool to create at deploy time. `base` / `quote` are
 *  the coin symbols the deepbook composite resolves to coin records
 *  from user-supplied coin/package members. */
export interface DeepbookPoolSpec {
	readonly name: string;
	readonly base: string;
	readonly quote: string;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
	/** Whitelisted? Defaults true for local deploy (no DEEP-burn). */
	readonly whitelisted?: boolean;
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

/** Account member alias — the user passes the value returned by
 *  `account('name')`. Composite-typed at the factory boundary so a
 *  package-shaped member is a TS error. The wide `Consumes` /
 *  `Caps` / `Siblings` generics let downstream `consumes:` arrays
 *  carry the user-typed member without losing narrow tag-id info. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AccountMemberAlias<Name extends string = string> = StackMember<
	Tag<`account/${Name}`, AccountValue>,
	ReadonlyArray<AnyTag>,
	ReadonlyArray<CapabilityDecl>,
	ReadonlyArray<LiftedSiblingKey>
>;

export type PackageMemberAlias<Name extends string = string> = StackMember<
	Tag<`package:${Name}`, ResolvedPackage>,
	ReadonlyArray<AnyTag>,
	ReadonlyArray<CapabilityDecl>,
	ReadonlyArray<LiftedSiblingKey>
>;
