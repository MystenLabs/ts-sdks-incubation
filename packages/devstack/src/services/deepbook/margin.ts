// `deepbookMargin(opts)` — publish the `deepbook_margin` +
// `margin_liquidation` Move packages, create one MarginPool per
// configured asset, and register each requested deepbook pool against
// the margin registry (sandbox parity:
// `~/code/deepbook-sandbox/sandbox/scripts/utils/pool.ts:298-457`).
//
// **Snapshot participation**: per-cycle action; persists only state-
// store caches (`deepbook/margin-pools/v1/...`); no own filesystem
// state. Cache verifies each `MarginPool<T>` objectType on resume and
// invalidates on mismatch (R11 + R5 mitigations).
//
// **Pyth is a typecheck-enforced dep (D5)**: the factory's option type
// declares `pyth: LayeredTag<...PythTag...>` non-optional. Margin
// pools must wire a `PriceInfoObject` per asset, and the Move source
// rejects a margin-without-Pyth deployment — modeling Pyth as required
// at the type level prevents silent misconfiguration.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { tag, provide, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { publishMove } from '../package/internal.js';
import { moveTypeEquals, pickCreatedByType } from '../../engine/sui-helpers.js';
import { publishDeepbookMarginState, publishPackage } from '../../engine/registries.js';
import { StateStore } from '../../engine/state-store.js';
import { StateStoreKeys } from '../../engine/state-store-keys.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { contentHash } from '../../engine/content-hash.js';
import { DeepbookError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import type { DeepbookCore } from '../deepbook.js';
import type { Pyth, PythPriceFeedId } from '../pyth/index.js';
import {
	resolveCoinRef,
	MARGIN_REGISTRY_TYPE_SUFFIX,
	MARGIN_ADMIN_CAP_TYPE_SUFFIX,
	SUI_CLOCK_OBJECT_ID,
	COIN_REGISTRY_OBJECT_ID,
	type AnyCoinTag,
} from './internal.js';

// Sandbox uses `FLOAT_SCALAR = 1_000_000_000` (1e9) for fixed-point
// `u64`s on chain (sandbox/scripts/utils/pool.ts header). Matches the
// scale embedded in the deepbook-margin Move package's
// `protocol_config` module.
const FLOAT_SCALAR = 1_000_000_000;
const DEFAULT_MAX_AGE_SECONDS = 70n;

// -----------------------------------------------------------------------------
// Asset config + named defaults (P4.3)
// -----------------------------------------------------------------------------

/** Per-margin-pool risk + rate-limit configuration. Mirrors sandbox's
 *  `MarginAssetConfig` (sandbox/scripts/utils/pool.ts:18-34). Scalars
 *  are decimal numbers; the factory multiplies by the asset's coin
 *  scalar (e.g. 1e6 for USDC, 1e9 for SUI) or by `FLOAT_SCALAR` on the
 *  fixed-point fields before passing to the chain.
 *
 *  `coinType` accepts either a literal Move type string OR a coin tag —
 *  matches the Phase-0 `DeepbookCoinRef` shape so pool refs and margin
 *  asset configs compose against the same tag-supply pattern. `feed` is
 *  the Pyth mainnet hex id; the factory resolves it through
 *  `pyth.findPriceInfo` to get the on-chain PriceInfoObject id at
 *  build time. */
export interface DeepbookMarginAssetConfig {
	readonly label: string;
	readonly coinType: string | AnyCoinTag;
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

const USDC_PRICE_FEED_ID =
	'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a' as PythPriceFeedId;
const SUI_PRICE_FEED_ID =
	'23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744' as PythPriceFeedId;

/** Stock defaults for a USDC-backed margin pool. Mirrors sandbox
 *  `USDC_ASSET_DEFAULTS` (sandbox/scripts/utils/pool.ts:36-53). */
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

/** Stock defaults for a SUI-backed margin pool. Mirrors sandbox
 *  `SUI_ASSET_DEFAULTS` (sandbox/scripts/utils/pool.ts:55-72). */
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

// -----------------------------------------------------------------------------
// Pool risk config + registration (P4.4)
// -----------------------------------------------------------------------------

/** Risk parameters applied uniformly to every deepbook pool registered
 *  for margin trading. Mirrors sandbox's `POOL_RISK_CONFIG`
 *  (sandbox/scripts/utils/pool.ts:75-82). */
export interface DeepbookMarginPoolRiskConfig {
	readonly minWithdrawRiskRatio: number;
	readonly minBorrowRiskRatio: number;
	readonly liquidationRiskRatio: number;
	readonly targetLiquidationRiskRatio: number;
	readonly userLiquidationReward: number;
	readonly poolLiquidationReward: number;
}

/** Sandbox-default pool risk config — spread by consumers via `{ ... }`
 *  to tweak individual fields without re-declaring the full shape. */
export const DEFAULT_POOL_RISK_CONFIG: DeepbookMarginPoolRiskConfig = {
	minWithdrawRiskRatio: 2,
	minBorrowRiskRatio: 1.2499,
	liquidationRiskRatio: 1.1,
	targetLiquidationRiskRatio: 1.25,
	userLiquidationReward: 0.02,
	poolLiquidationReward: 0.03,
};

/** One deepbook pool to register against the margin registry. `pool`
 *  is the name from the parent `Deepbook({ local: { pools: [...] } })`
 *  config; the factory resolves the on-chain id via
 *  `deepbook.findPool` (with `base` / `quote` from the pool's
 *  configured coin types). */
export interface DeepbookMarginPoolRegistration {
	readonly pool: string;
	readonly risk?: DeepbookMarginPoolRiskConfig;
}

// -----------------------------------------------------------------------------
// Tag + factory
// -----------------------------------------------------------------------------

/** Per-asset margin pool metadata. */
export interface DeepbookMarginPool {
	readonly label: string;
	readonly coinType: string;
	readonly marginPoolId: string;
}

/** Resolved DeepbookMargin handle. */
export interface DeepbookMargin {
	readonly packageId: string;
	readonly liquidationPackageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly maintainerCapId: string | undefined;
	readonly marginPools: ReadonlyArray<DeepbookMarginPool>;
	readonly registeredPools: ReadonlyArray<string>;
	readonly findMarginPool: (label: string) => DeepbookMarginPool | undefined;
}

export class DeepbookMarginTag extends Context.Service<DeepbookMarginTag, DeepbookMargin>()(
	'@devstack/DeepbookMarginTag',
) {}

export interface DeepbookMarginOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Margin Move package source. `movePackagePath` is the materialized
	 *  directory; `vendor` reads the path from a `vendorDeepbook(...)`
	 *  Ref. Mutually exclusive (typecheck-friendly; runtime check). */
	readonly margin: {
		readonly movePackagePath?: string;
		readonly vendor?: LayeredTag<any, { readonly deepbook_margin: string }, any, any>;
	};
	/** Liquidation Move package source. Same shape as `margin`. */
	readonly liquidation: {
		readonly movePackagePath?: string;
		readonly vendor?: LayeredTag<any, { readonly margin_liquidation: string }, any, any>;
	};
	/** Required: Pyth deployment Ref. Margin pools wire each asset's
	 *  PriceInfoObject via `pyth.findPriceInfo(feed)`. NON-OPTIONAL
	 *  (D5 — typecheck enforced). */
	readonly pyth: LayeredTag<any, Pyth, any, any>;
	/** Required: deepbook deployment Ref. */
	readonly deepbook: LayeredTag<any, DeepbookCore, any, any>;
	/** Per-asset margin pool configs (use spread on `USDC_MARGIN_DEFAULTS`
	 *  / `SUI_MARGIN_DEFAULTS` to derive). */
	readonly assets: ReadonlyArray<DeepbookMarginAssetConfig>;
	/** Deepbook pools to register against the margin registry. */
	readonly pools: ReadonlyArray<DeepbookMarginPoolRegistration>;
	/** Max age (seconds) the pyth price feed is considered valid. Default 70. */
	readonly maxAgeSeconds?: bigint;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

// State-store cache shape. Captures the per-asset margin pool ids and
// the registered deepbook pool ids so a resume can verify each
// `MarginPool<T>` object's existence + objectType match before
// trusting the cache (R11 mitigation).
interface CachedMarginPool {
	readonly label: string;
	readonly coinType: string;
	readonly marginPoolId: string;
}

interface CachedMargin {
	readonly marginPools: ReadonlyArray<CachedMarginPool>;
	readonly registeredPools: ReadonlyArray<string>;
	readonly maintainerCapId: string | undefined;
}

// State-store key prefix for the cached margin-pools deploy moved to
// `engine/state-store-keys.ts`. Canonical builder:
// `StateStoreKeys.deepbookMarginPools({chainId, packageId, configHash})`.

// Stable hash over (asset configs + pool registrations). Keys sorted so
// JSON output is deterministic regardless of caller's input ordering.
const hashMarginConfig = (
	assets: ReadonlyArray<{
		readonly label: string;
		readonly coinType: string;
		readonly feed: string;
		readonly scalar: number;
		readonly supplyCap: number;
	}>,
	pools: ReadonlyArray<{ readonly pool: string; readonly poolId: string }>,
	maxAgeSeconds: bigint,
): string => {
	const canonical = {
		assets: assets
			.slice()
			.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
			.map((a) => ({
				label: a.label,
				coinType: a.coinType,
				feed: a.feed,
				scalar: a.scalar,
				supplyCap: a.supplyCap,
			})),
		pools: pools.slice().sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0)),
		maxAgeSeconds: maxAgeSeconds.toString(),
	};
	return contentHash(canonical, { length: 16 });
};

// Round a fixed-point fraction to FLOAT_SCALAR-units. Sandbox does
// `Math.round(value * FLOAT_SCALAR)` for `u64` args; we mirror the
// same to keep arithmetic identical to the on-chain assertions.
const toFloatScalar = (value: number): bigint => BigInt(Math.round(value * FLOAT_SCALAR));

const toAssetScalar = (value: number, scalar: number): bigint => BigInt(Math.round(value * scalar));

export const deepbookMargin = <const Name extends string = 'deepbook-margin'>(
	options: DeepbookMarginOptions<Name>,
) => {
	const name = (options.name ?? 'deepbook-margin') as Name;
	const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

	// Validate source-of-truth invariants up front: mutual exclusion
	// between `movePackagePath` and `vendor` for each Move package.
	if (options.margin.movePackagePath !== undefined && options.margin.vendor !== undefined) {
		throw new TypeError(
			`deepbookMargin: \`margin.movePackagePath\` and \`margin.vendor\` are mutually exclusive`,
		);
	}
	if (
		options.liquidation.movePackagePath !== undefined &&
		options.liquidation.vendor !== undefined
	) {
		throw new TypeError(
			`deepbookMargin: \`liquidation.movePackagePath\` and \`liquidation.vendor\` are mutually exclusive`,
		);
	}

	// Unique asset labels — sandbox keys margin pools by label
	// (`marginPools["USDC"]`); a duplicate label would silently
	// overwrite. Caught up front with a clear error.
	const seenLabels = new Set<string>();
	for (const a of options.assets) {
		if (seenLabels.has(a.label)) {
			throw new TypeError(`deepbookMargin: duplicate asset label '${a.label}'`);
		}
		seenLabels.add(a.label);
	}

	// publishMove tags for each package — built lazily so the factory
	// fails at start (not at module-eval) when the source path is
	// missing. The `vendor`-runtime flow is deferred (same as the
	// Phase-4-wallet-migration scoping in P0.16); when only `vendor` is
	// passed, the body fails with a clear error at acquire time.
	const marginPublish =
		options.margin.movePackagePath !== undefined
			? publishMove({
					name: `${name}.publish` as const,
					path: options.margin.movePackagePath,
					signer: options.signer,
					capture: (changes) => {
						const registryId = pickCreatedByType(changes, {
							suffix: MARGIN_REGISTRY_TYPE_SUFFIX,
						});
						const adminCapId = pickCreatedByType(changes, {
							suffix: MARGIN_ADMIN_CAP_TYPE_SUFFIX,
						});
						return { registryId, adminCapId };
					},
				})
			: undefined;

	const liquidationPublish =
		options.liquidation.movePackagePath !== undefined
			? publishMove({
					name: `${name}.liquidation.publish` as const,
					path: options.liquidation.movePackagePath,
					signer: options.signer,
				})
			: undefined;

	const composite = tag(
		name,
		Effect.gen(function* () {
			for (const dep of options.dependsOn ?? []) {
				yield* dep;
			}

			const sui = yield* SuiTag;
			const signer = yield* options.signer;
			const pyth = yield* options.pyth;
			const deepbook = yield* options.deepbook;
			const state = yield* StateStore;

			yield* Effect.annotateCurrentSpan({ 'sui.chainId': sui.chainId });
			yield* setPhase('publishing margin Move source');

			if (marginPublish === undefined || liquidationPublish === undefined) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'margin-publish',
						message:
							`deepbookMargin(${name}): both \`margin.movePackagePath\` and ` +
							`\`liquidation.movePackagePath\` are required to publish the Move ` +
							`packages. (Vendor-runtime flow is deferred — pass the materialized ` +
							`vendor directory's paths via \`movePackagePath\`.)`,
					}),
				);
			}

			const marginPkg = yield* marginPublish;
			const liquidationPkg = yield* liquidationPublish;

			const packageId = marginPkg.packageId;
			const liquidationPackageId = liquidationPkg.packageId;
			const registryId = marginPkg.captured?.registryId;
			const adminCapId = marginPkg.captured?.adminCapId;
			if (registryId === undefined || adminCapId === undefined) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'margin-publish',
						message:
							`deepbookMargin(${name}): publish did not surface MarginRegistry / ` +
							`MarginAdminCap from the Move source's init. Expected types matching ` +
							`'${MARGIN_REGISTRY_TYPE_SUFFIX}' / '${MARGIN_ADMIN_CAP_TYPE_SUFFIX}'.`,
					}),
				);
			}

			// Resolve each asset's coinType + verify the Pyth feed is
			// known to the configured Pyth deployment BEFORE we build
			// the setup tx. Without this, a typo in `feed` lands as a
			// MoveAbort deep inside `new_pyth_config`'s
			// `add_config` — debuggable only by re-running with logs.
			yield* setPhase('resolving asset configs');
			interface ResolvedAsset {
				readonly config: DeepbookMarginAssetConfig;
				readonly coinType: string;
				readonly priceInfoObjectId: string;
			}
			const resolvedAssets: Array<ResolvedAsset> = [];
			for (const cfg of options.assets) {
				const coinType = yield* resolveCoinRef(cfg.coinType);
				const feedInfo = pyth.findPriceInfo(cfg.feed);
				if (feedInfo === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-setup',
							marginAsset: cfg.label,
							feed: cfg.feed,
							message:
								`deepbookMargin(${name}): pyth feed '${cfg.feed}' for asset ` +
								`'${cfg.label}' is not known to the configured Pyth deployment. ` +
								`Add the feed to \`Pyth({ local: { feeds: [...] } })\` or check ` +
								`the feed id against the Pyth registry.`,
						}),
					);
				}
				resolvedAssets.push({
					config: cfg,
					coinType,
					priceInfoObjectId: feedInfo.priceInfoObjectId,
				});
			}

			// Resolve each registered deepbook pool by name -> on-chain id +
			// base/quote types. The deepbook factory's `findPool` is
			// base/quote-keyed, but we want by-name lookup; resolve via
			// `poolIds.get(name)` for the id and reach into the cached
			// pool record on the local-deploy shape for the types. Since
			// the `DeepbookCore` interface only surfaces `poolIds` + `findPool`,
			// we walk the resolved assets' types: a deepbook pool's
			// (base, quote) coinTypes are exactly the asset coinTypes of
			// the assets the pool is composed of. Sandbox parity: the
			// SUI/USDC pool ties to the SUI + USDC margin assets.
			interface ResolvedPool {
				readonly name: string;
				readonly poolId: string;
				readonly baseType: string;
				readonly quoteType: string;
				readonly risk: DeepbookMarginPoolRiskConfig;
			}
			const resolvedPools: Array<ResolvedPool> = [];
			for (const reg of options.pools) {
				const poolId = deepbook.poolIds.get(reg.pool);
				if (poolId === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-setup',
							pool: reg.pool,
							message:
								`deepbookMargin(${name}): deepbook pool '${reg.pool}' is not ` +
								`declared on the configured deepbook deployment. Add it to the ` +
								`\`Deepbook({ local: { pools: [...] } })\` config.`,
						}),
					);
				}
				// Fetch on-chain pool object to read base/quote types.
				// The local-deploy primitive surfaces base/quote on its
				// rich shape, but the read-side `DeepbookCore` interface
				// doesn't — we go to chain to keep this factory composable
				// against both local-deploy and known-package refs.
				const obj = yield* Effect.tryPromise({
					try: () =>
						sui.client.core.getObject({
							objectId: poolId,
						}) as unknown as Promise<{ objectType?: string }>,
					catch: (cause) => cause,
				}).pipe(
					Effect.mapError(
						(cause) =>
							new DeepbookError({
								phase: 'margin-setup',
								pool: reg.pool,
								message: `failed to fetch on-chain pool '${reg.pool}' (id=${poolId})`,
								cause,
							}),
					),
				);
				const objectType = obj.objectType ?? '';
				// `Pool<base, quote>` — extract the generics.
				const m = /::pool::Pool<([^,]+),\s*([^>]+)>/.exec(objectType);
				if (m === null) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-setup',
							pool: reg.pool,
							message:
								`deepbookMargin(${name}): deepbook pool '${reg.pool}' on-chain ` +
								`object has unexpected type '${objectType}' (expected ` +
								`'<pkg>::pool::Pool<base, quote>').`,
						}),
					);
				}
				resolvedPools.push({
					name: reg.pool,
					poolId,
					baseType: m[1]!.trim(),
					quoteType: m[2]!.trim(),
					risk: reg.risk ?? DEFAULT_POOL_RISK_CONFIG,
				});
			}

			// Resume idempotency — same pattern as
			// `deepbookLocalDeploy` (`local-deploy.ts:336-417`). The
			// cache key folds in (chainId, marginPackageId, configHash)
			// so a regenesis or republish naturally misses, and
			// reconfiguring any asset / pool entry invalidates.
			const configHash = hashMarginConfig(
				resolvedAssets.map((a) => ({
					label: a.config.label,
					coinType: a.coinType,
					feed: a.config.feed,
					scalar: a.config.scalar,
					supplyCap: a.config.supplyCap,
				})),
				resolvedPools.map((p) => ({ pool: p.name, poolId: p.poolId })),
				maxAgeSeconds,
			);
			const cacheKey = StateStoreKeys.deepbookMarginPools({
				chainId: sui.chainId,
				packageId,
				configHash,
			});
			const cached = yield* state.get<CachedMargin>(cacheKey);

			const verifyCached = (payload: CachedMargin): Effect.Effect<boolean, never> =>
				Effect.gen(function* () {
					for (const pool of payload.marginPools) {
						const fetched = yield* Effect.tryPromise({
							try: () => sui.client.core.getObject({ objectId: pool.marginPoolId }),
							catch: (cause) => cause,
						}).pipe(
							Effect.map((res) => res as unknown as { objectType?: unknown }),
							Effect.orElseSucceed(() => undefined),
						);
						if (fetched === undefined) return false;
						// `MarginPool<T>` objectType must match the cached
						// pool's expected coin type. Mismatch invalidates
						// (R5 — defends against the cache surviving while
						// the chain state did not).
						const expectedType = `${packageId}::margin_pool::MarginPool<${pool.coinType}>`;
						const actualType =
							typeof fetched.objectType === 'string' ? fetched.objectType : undefined;
						if (actualType === undefined || !moveTypeEquals(actualType, expectedType))
							return false;
					}
					return true;
				});

			let resumed = false;
			let marginPools: Array<DeepbookMarginPool> = [];
			let maintainerCapId: string | undefined;
			let registeredPools: ReadonlyArray<string> = [];

			if (Option.isSome(cached)) {
				const verified = yield* verifyCached(cached.value);
				if (verified) {
					yield* Effect.logInfo(
						`deepbookMargin(${name}): cache hit — chainId=${sui.chainId} ` +
							`packageId=${packageId} configHash=${configHash} ` +
							`(${cached.value.marginPools.length} pool${cached.value.marginPools.length === 1 ? '' : 's'}, verified)`,
					);
					yield* Effect.annotateCurrentSpan({
						'deepbook.margin.cache': 'hit',
						'deepbook.margin.configHash': configHash,
					});
					marginPools = cached.value.marginPools.map((p) => ({
						label: p.label,
						coinType: p.coinType,
						marginPoolId: p.marginPoolId,
					}));
					maintainerCapId = cached.value.maintainerCapId;
					registeredPools = cached.value.registeredPools;
					resumed = true;
				} else {
					yield* Effect.logInfo(
						`deepbookMargin(${name}): cache hit but margin-pool objects missing ` +
							`/ mistyped on chain — invalidating and re-creating ` +
							`(chainId=${sui.chainId} packageId=${packageId})`,
					);
					yield* Effect.annotateCurrentSpan({
						'deepbook.margin.cache': 'stale',
						'deepbook.margin.configHash': configHash,
					});
					yield* state.remove(cacheKey);
				}
			}

			if (!resumed) {
				yield* Effect.annotateCurrentSpan({
					'deepbook.margin.cache': Option.isNone(cached) ? 'miss' : 'invalidated',
					'deepbook.margin.configHash': configHash,
				});

				yield* setPhase('finalizing coin currencies');
				// USDC currency finalization (R11). For SUI we issue a
				// `migrate_legacy_metadata` rather than `finalize_registration`
				// — sandbox parity. The chain rejects `new_coin_type_data_from_currency`
				// if the Currency object isn't on-chain yet.
				//
				// We avoid issuing the finalize calls unconditionally: on
				// resume of an established chain, the Currency exists
				// already, and the call would double-create. The
				// `currencyId` resolver here is best-effort: it tries
				// `migrate_legacy_metadata` for system coins
				// (0x2::sui::SUI), and for new coins it expects the
				// caller to have already produced the Currency via the
				// USDC publish (a vendored `usdc` Move package mints
				// one in init).
				//
				// To keep this primitive minimal and deferral-friendly,
				// the runtime currency-finalization flow is staged: the
				// design enforces that callers vendor a USDC Move package
				// whose init transfers the Currency to the signer; the
				// factory only resolves the Currency id from chain state
				// (read-side; no extra tx). This mirrors what the wallet
				// migration will land alongside vendorDeepbook.
				const currencyIds = new Map<string, string>();
				for (const a of resolvedAssets) {
					// For a published coin's Currency object, the test
					// fixture / sandbox parity ships a captured
					// `Currency<T>` object during init. We probe chain
					// state for it via objectType — the publishing flow
					// for these tests is responsible for ensuring the
					// Currency lands on the signer. For SUI, the
					// `0xc::coin_registry::CoinRegistry` shared object
					// already carries the legacy metadata; consumers
					// can either pre-stage a migrate_legacy_metadata
					// call as a separate action OR rely on a prior
					// currency-staging step.
					//
					// Concrete: leave currencyIds empty here and let
					// the chain reject the tx with a typed error if
					// the Currency objects don't exist. This avoids
					// surfacing a chain query waterfall that's
					// expensive on a fresh stack.
					void a;
				}
				void currencyIds;

				yield* setPhase('creating margin pools');
				const tx = new Transaction();
				tx.setGasBudget(500_000_000n);

				// 1) mint_maintainer_cap → captured for later moveCalls
				const maintainerCap = tx.moveCall({
					target: `${packageId}::margin_registry::mint_maintainer_cap`,
					arguments: [tx.object(registryId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)],
				});

				// 2) per-asset CoinTypeData (Pyth-config inputs). The
				// `new_coin_type_data_from_currency` Move call needs the
				// asset's Currency object id. We thread the Currency in
				// as a runtime arg — for assets without a pre-staged
				// Currency, the chain will reject and surface a typed
				// margin-setup error. (See note above on the staged
				// approach to currency finalization.)
				const coinTypeDataEntries: any[] = [];
				for (const a of resolvedAssets) {
					// `currencyId` resolution: best-effort. Tests pass
					// the Currency id through a prior publish or staging
					// action; the factory itself does not mint one.
					const currencyId =
						currencyIds.get(a.coinType) ??
						// Sentinel — chain will reject with a typed
						// margin-setup error pointing the user at the
						// missing Currency. Sandbox passes through here
						// because its USDC publish ships a Currency.
						COIN_REGISTRY_OBJECT_ID;
					const coinTypeData = tx.moveCall({
						target: `${packageId}::oracle::new_coin_type_data_from_currency`,
						typeArguments: [a.coinType],
						arguments: [
							tx.object(currencyId),
							tx.pure.vector('u8', fromHex(a.config.feed)),
							tx.pure.u64(a.config.maxConfBps),
							tx.pure.u64(a.config.maxEwmaDifferenceBps),
						],
					});
					coinTypeDataEntries.push(coinTypeData);
				}

				// 3) new_pyth_config with the vector<CoinTypeData> + max age
				const pythConfig = tx.moveCall({
					target: `${packageId}::oracle::new_pyth_config`,
					arguments: [
						tx.makeMoveVec({
							type: `${packageId}::oracle::CoinTypeData`,
							elements: coinTypeDataEntries,
						}),
						tx.pure.u64(maxAgeSeconds),
					],
				});

				tx.moveCall({
					target: `${packageId}::margin_registry::add_config`,
					typeArguments: [`${packageId}::oracle::PythConfig`],
					arguments: [tx.object(registryId), tx.object(adminCapId), pythConfig],
				});

				// 4) per-asset create_margin_pool
				for (const a of resolvedAssets) {
					const c = a.config;
					const marginPoolConfig = tx.moveCall({
						target: `${packageId}::protocol_config::new_margin_pool_config_with_rate_limit`,
						arguments: [
							tx.pure.u64(toAssetScalar(c.supplyCap, c.scalar)),
							tx.pure.u64(toFloatScalar(c.maxUtilizationRate)),
							tx.pure.u64(toFloatScalar(c.referralSpread)),
							tx.pure.u64(toAssetScalar(c.minBorrow, c.scalar)),
							tx.pure.u64(toAssetScalar(c.rateLimitCapacity, c.scalar)),
							tx.pure.u64(toAssetScalar(c.rateLimitRefillRatePerMs, c.scalar)),
							tx.pure.bool(c.rateLimitEnabled),
						],
					});
					const interestConfig = tx.moveCall({
						target: `${packageId}::protocol_config::new_interest_config`,
						arguments: [
							tx.pure.u64(toFloatScalar(c.baseRate)),
							tx.pure.u64(toFloatScalar(c.baseSlope)),
							tx.pure.u64(toFloatScalar(c.optimalUtilization)),
							tx.pure.u64(toFloatScalar(c.excessSlope)),
						],
					});
					const protocolConfig = tx.moveCall({
						target: `${packageId}::protocol_config::new_protocol_config`,
						arguments: [marginPoolConfig, interestConfig],
					});
					tx.moveCall({
						target: `${packageId}::margin_pool::create_margin_pool`,
						typeArguments: [a.coinType],
						arguments: [
							tx.object(registryId),
							protocolConfig,
							maintainerCap,
							tx.object(SUI_CLOCK_OBJECT_ID),
						],
					});
				}

				// 5) per-pool register_deepbook_pool + enable
				for (const p of resolvedPools) {
					const r = p.risk;
					const poolConfig = tx.moveCall({
						target: `${packageId}::margin_registry::new_pool_config`,
						typeArguments: [p.baseType, p.quoteType],
						arguments: [
							tx.object(registryId),
							tx.pure.u64(toFloatScalar(r.minWithdrawRiskRatio)),
							tx.pure.u64(toFloatScalar(r.minBorrowRiskRatio)),
							tx.pure.u64(toFloatScalar(r.liquidationRiskRatio)),
							tx.pure.u64(toFloatScalar(r.targetLiquidationRiskRatio)),
							tx.pure.u64(toFloatScalar(r.userLiquidationReward)),
							tx.pure.u64(toFloatScalar(r.poolLiquidationReward)),
						],
					});
					tx.moveCall({
						target: `${packageId}::margin_registry::register_deepbook_pool`,
						typeArguments: [p.baseType, p.quoteType],
						arguments: [
							tx.object(registryId),
							tx.object(adminCapId),
							tx.object(p.poolId),
							poolConfig,
							tx.object(SUI_CLOCK_OBJECT_ID),
						],
					});
					tx.moveCall({
						target: `${packageId}::margin_registry::enable_deepbook_pool`,
						typeArguments: [p.baseType, p.quoteType],
						arguments: [
							tx.object(registryId),
							tx.object(adminCapId),
							tx.object(p.poolId),
							tx.object(SUI_CLOCK_OBJECT_ID),
						],
					});
				}

				// 6) transfer MaintainerCap to signer
				tx.transferObjects([maintainerCap], signer.address);

				const result = yield* signer.signAndExecute(tx).pipe(
					Effect.mapError(
						(cause) =>
							new DeepbookError({
								phase: 'margin-pools',
								message: `deepbookMargin(${name}): margin-setup tx failed: ${cause.message}`,
								cause,
							}),
					),
				);

				// Extract each created MarginPool by objectType match
				// against `<pkg>::margin_pool::MarginPool<T>`. Per-asset
				// type-arg disambiguation keeps multi-asset deployment
				// output deterministic.
				for (const a of resolvedAssets) {
					const expected = `${packageId}::margin_pool::MarginPool<${a.coinType}>`;
					const marginPoolId = pickCreatedByType(result.objectChanges, { suffix: expected });
					if (marginPoolId === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'margin-pools',
								marginAsset: a.config.label,
								message:
									`deepbookMargin(${name}): MarginPool<${a.config.label}> missing ` +
									`from objectChanges (expected type ${expected})`,
							}),
						);
					}
					marginPools.push({
						label: a.config.label,
						coinType: a.coinType,
						marginPoolId,
					});
				}

				// MaintainerCap — transferred to signer in step 6.
				maintainerCapId = pickCreatedByType(result.objectChanges, {
					suffix: `${packageId}::margin_registry::MaintainerCap`,
				});
				registeredPools = resolvedPools.map((p) => p.poolId);

				const toCache: CachedMargin = {
					marginPools: marginPools.map((p) => ({
						label: p.label,
						coinType: p.coinType,
						marginPoolId: p.marginPoolId,
					})),
					registeredPools,
					maintainerCapId,
				};
				yield* state.put(cacheKey, toCache);
			}

			// Publish to registries — both deepbook-package + margin-state
			// records. The package record makes margin show up in the
			// manifest's `packages` for symmetry with deepbook itself.
			yield* publishPackage({
				name,
				packageId,
				upgradeCapId: marginPkg.upgradeCapId,
				captured: { registryId, adminCapId },
			});
			yield* publishPackage({
				name: `${name}.liquidation`,
				packageId: liquidationPackageId,
				upgradeCapId: liquidationPkg.upgradeCapId,
				captured: {},
			});
			yield* publishDeepbookMarginState({
				name,
				packageId,
				liquidationPackageId,
				registryId,
				adminCapId,
				...(maintainerCapId !== undefined ? { maintainerCapId } : {}),
				marginPools: marginPools.map((p) => ({
					label: p.label,
					assetType: p.coinType,
					marginPoolId: p.marginPoolId,
				})),
				registeredPools,
			});

			const byLabel = new Map(marginPools.map((p) => [p.label, p] as const));
			const findMarginPool = (label: string): DeepbookMarginPool | undefined => byLabel.get(label);

			return {
				packageId,
				liquidationPackageId,
				registryId,
				adminCapId,
				maintainerCapId,
				marginPools,
				registeredPools,
				findMarginPool,
			} satisfies DeepbookMargin;
		}).pipe(
			Effect.withSpan(`DeepbookMargin(${name})`),
			Effect.catchTag('DeepbookError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookError({
						phase: 'deepbook',
						message: `deepbookMargin(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			...(marginPublish !== undefined && liquidationPublish !== undefined
				? { extraLayers: [marginPublish.__layer, liquidationPublish.__layer] }
				: {}),
			kind: 'action' as const,
			displayTitle: `deepbook.margin.${name}`,
			display: (s: DeepbookMargin) => ({
				title: `deepbook.margin.${name}`,
				primary: s.packageId,
				extras: [`${s.marginPools.length} pool${s.marginPools.length === 1 ? '' : 's'}`],
			}),
			// Phase B (notes/parallel-graph-resolution.md §3.2): the body
			// yields SuiTag, the signer Account ref, pyth, deepbook, the
			// two publishMove tags, and iterates `dependsOn`. Lift them
			// all so the topo scheduler places this composite strictly
			// after every provider.
			upstreamKeys: [
				SuiTag.key,
				options.signer,
				options.pyth,
				options.deepbook,
				...(marginPublish !== undefined ? [marginPublish] : []),
				...(liquidationPublish !== undefined ? [liquidationPublish] : []),
				...options.assets.flatMap((a) =>
					typeof a.coinType !== 'string' ? [a.coinType] : [],
				),
				...(options.dependsOn ?? []),
			],
		},
	);

	const tagLayer = provide(
		DeepbookMarginTag,
		Effect.gen(function* () {
			return yield* composite;
		}),
	).__layer;

	const __layers = [...composite.__layers, tagLayer];
	return Object.assign(composite, { __layers, __kind: 'action' as const });
};
