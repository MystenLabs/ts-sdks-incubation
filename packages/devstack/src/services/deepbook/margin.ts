// `deepbookMargin(opts)` — publish the `deepbook_margin` +
// `margin_liquidation` Move packages, create one MarginPool per
// configured asset, and register each requested deepbook pool against
// the margin registry (sandbox parity:
// `~/code/deepbook-sandbox/sandbox/scripts/utils/pool.ts:298-457`).
//
// **Snapshot participation**: per-cycle action; persists only state-
// store caches (`deepbook/margin-pools/...`); no own filesystem state.
// Cache verifies each `MarginPool<T>` objectType on resume and
// invalidates on mismatch.
//
// **Pyth is a typecheck-enforced dep (D5)**: the factory's option type
// declares `pyth: LayeredTag<...PythTag...>` non-optional. Margin
// pools must wire a `PriceInfoObject` per asset, and the Move source
// rejects a margin-without-Pyth deployment — modeling Pyth as required
// at the type level prevents silent misconfiguration.
//
// Phase C migration: the cache+verify+register dance routes through
// `onChainArtifact`. The verify probe uses
// `ChainProbe.objectsMatchTypes` (Schema-validated SDK responses) with
// the address-form-agnostic `moveTypeEquals` matcher to confirm each
// `MarginPool<T>` objectType matches its expected canonical form (B5
// fix). The pre-Phase-C verify reached for `as unknown as
// { objectType? }` against the raw `client.core.getObject` response;
// the typed accessor closes that footgun.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { provide, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { publishMove } from '../package/internal.js';
import { moveTypeEquals, pickCreatedByType } from '../../engine/sui-helpers.js';
import { publishDeepbookMarginState, publishPackage } from '../../engine/registries.js';
import { onChainArtifact } from '../../engine/on-chain-artifact.js';
import { ChainProbe } from '../../engine/chain-probe.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
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

const FLOAT_SCALAR = 1_000_000_000;
const DEFAULT_MAX_AGE_SECONDS = 70n;

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

export interface DeepbookMarginPoolRiskConfig {
	readonly minWithdrawRiskRatio: number;
	readonly minBorrowRiskRatio: number;
	readonly liquidationRiskRatio: number;
	readonly targetLiquidationRiskRatio: number;
	readonly userLiquidationReward: number;
	readonly poolLiquidationReward: number;
}

export const DEFAULT_POOL_RISK_CONFIG: DeepbookMarginPoolRiskConfig = {
	minWithdrawRiskRatio: 2,
	minBorrowRiskRatio: 1.2499,
	liquidationRiskRatio: 1.1,
	targetLiquidationRiskRatio: 1.25,
	userLiquidationReward: 0.02,
	poolLiquidationReward: 0.03,
};

export interface DeepbookMarginPoolRegistration {
	readonly pool: string;
	readonly risk?: DeepbookMarginPoolRiskConfig;
}

export interface DeepbookMarginPool {
	readonly label: string;
	readonly coinType: string;
	readonly marginPoolId: string;
}

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
	readonly margin: {
		readonly movePackagePath?: string;
		readonly vendor?: LayeredTag<any, { readonly deepbook_margin: string }, any, any>;
	};
	readonly liquidation: {
		readonly movePackagePath?: string;
		readonly vendor?: LayeredTag<any, { readonly margin_liquidation: string }, any, any>;
	};
	readonly pyth: LayeredTag<any, Pyth, any, any>;
	readonly deepbook: LayeredTag<any, DeepbookCore, any, any>;
	readonly assets: ReadonlyArray<DeepbookMarginAssetConfig>;
	readonly pools: ReadonlyArray<DeepbookMarginPoolRegistration>;
	readonly maxAgeSeconds?: bigint;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

const toFloatScalar = (value: number): bigint => BigInt(Math.round(value * FLOAT_SCALAR));
const toAssetScalar = (value: number, scalar: number): bigint => BigInt(Math.round(value * scalar));

export const deepbookMargin = <const Name extends string = 'deepbook-margin'>(
	options: DeepbookMarginOptions<Name>,
) => {
	const name = (options.name ?? 'deepbook-margin') as Name;
	const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
	if (options.margin.movePackagePath !== undefined && options.margin.vendor !== undefined) {
		throw new TypeError(`deepbookMargin: \`margin.movePackagePath\` and \`margin.vendor\` are mutually exclusive`);
	}
	if (options.liquidation.movePackagePath !== undefined && options.liquidation.vendor !== undefined) {
		throw new TypeError(`deepbookMargin: \`liquidation.movePackagePath\` and \`liquidation.vendor\` are mutually exclusive`);
	}
	const seenLabels = new Set<string>();
	for (const a of options.assets) {
		if (seenLabels.has(a.label)) {
			throw new TypeError(`deepbookMargin: duplicate asset label '${a.label}'`);
		}
		seenLabels.add(a.label);
	}

	const marginPublish =
		options.margin.movePackagePath !== undefined
			? publishMove({
					name: `${name}.publish` as const,
					path: options.margin.movePackagePath,
					signer: options.signer,
					capture: (changes) => {
						const registryId = pickCreatedByType(changes, { suffix: MARGIN_REGISTRY_TYPE_SUFFIX });
						const adminCapId = pickCreatedByType(changes, { suffix: MARGIN_ADMIN_CAP_TYPE_SUFFIX });
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

	const coinTags = options.assets.flatMap((a) => (typeof a.coinType !== 'string' ? [a.coinType] : []));
	const dependsOn = options.dependsOn ?? [];
	const extraUpstream: Record<string, LayeredTag<any, any, any, any>> = {};
	for (let i = 0; i < coinTags.length; i++) extraUpstream[`coin${i}`] = coinTags[i]!;
	for (let i = 0; i < dependsOn.length; i++) extraUpstream[`dep${i}`] = dependsOn[i]!;

	const composite = onChainArtifact({
		name,
		kind: 'action',
		plugin: 'deepbook',
		displayTitle: `deepbook.margin.${name}`,
		display: (s: DeepbookMargin) => ({
			title: `deepbook.margin.${name}`,
			primary: s.packageId,
			extras: [`${s.marginPools.length} pool${s.marginPools.length === 1 ? '' : 's'}`],
		}),
		upstream: {
			signer: options.signer,
			pyth: options.pyth,
			deepbook: options.deepbook,
			marginPublish,
			liquidationPublish,
			...extraUpstream,
		},
		namespace: 'deepbook/margin-pools',
		label: `deepbookMargin(${name})`,
		inputs: ({ marginPublish, deepbook }) =>
			Effect.gen(function* () {
				if (marginPublish === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-publish',
							message: `deepbookMargin(${name}): \`margin.movePackagePath\` is required (vendor-runtime flow is deferred).`,
						}),
					);
				}
				const resolvedCoins: Array<{ readonly label: string; readonly coinType: string }> = [];
				for (const a of options.assets) {
					resolvedCoins.push({ label: a.label, coinType: yield* resolveCoinRef(a.coinType) });
				}
				return {
					marginPackageId: marginPublish.packageId,
					maxAgeSeconds: maxAgeSeconds.toString(),
					assets: resolvedCoins
						.slice()
						.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
						.map((c) => {
							const cfg = options.assets.find((x) => x.label === c.label)!;
							return { label: c.label, coinType: c.coinType, feed: cfg.feed, scalar: cfg.scalar, supplyCap: cfg.supplyCap };
						}),
					pools: options.pools
						.slice()
						.sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0))
						.map((p) => ({ pool: p.pool, poolId: deepbook.poolIds.get(p.pool) ?? '<unresolved>' })),
				};
			}),
		verify: ({ cached, chain }) =>
			chain
				.objectsMatchTypes(
					cached.marginPools.map((p) => ({
						objectId: p.marginPoolId,
						expectedType: `${cached.packageId}::margin_pool::MarginPool<${p.coinType}>`,
					})),
					moveTypeEquals,
				)
				.pipe(Effect.map((ok) => (ok ? cached : undefined))),
		produce: ({ signer, pyth, deepbook, marginPublish, liquidationPublish }) =>
			Effect.gen(function* () {
				yield* setPhase('publishing margin Move source');
				if (marginPublish === undefined || liquidationPublish === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-publish',
							message: `deepbookMargin(${name}): both margin + liquidation movePackagePath are required.`,
						}),
					);
				}
				const packageId = marginPublish.packageId;
				const liquidationPackageId = liquidationPublish.packageId;
				const registryId = marginPublish.captured?.registryId;
				const adminCapId = marginPublish.captured?.adminCapId;
				if (registryId === undefined || adminCapId === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-publish',
							message: `deepbookMargin(${name}): publish did not surface MarginRegistry / MarginAdminCap.`,
						}),
					);
				}
				yield* setPhase('resolving asset configs');
				interface ResolvedAsset {
					readonly config: DeepbookMarginAssetConfig;
					readonly coinType: string;
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
								message: `deepbookMargin(${name}): pyth feed '${cfg.feed}' for asset '${cfg.label}' is not known to the configured Pyth deployment.`,
							}),
						);
					}
					resolvedAssets.push({ config: cfg, coinType });
				}
				interface ResolvedPool {
					readonly name: string;
					readonly poolId: string;
					readonly baseType: string;
					readonly quoteType: string;
					readonly risk: DeepbookMarginPoolRiskConfig;
				}
				const chain = yield* ChainProbe;
				const resolvedPools: Array<ResolvedPool> = [];
				for (const reg of options.pools) {
					const poolId = deepbook.poolIds.get(reg.pool);
					if (poolId === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'margin-setup',
								pool: reg.pool,
								message: `deepbookMargin(${name}): deepbook pool '${reg.pool}' is not declared.`,
							}),
						);
					}
					const info = yield* chain.getObject(poolId);
					if (info === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'margin-setup',
								pool: reg.pool,
								message: `deepbookMargin(${name}): pool '${reg.pool}' on-chain object (id=${poolId}) could not be fetched.`,
							}),
						);
					}
					const m = /::pool::Pool<([^,]+),\s*([^>]+)>/.exec(info.type);
					if (m === null) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'margin-setup',
								pool: reg.pool,
								message: `deepbookMargin(${name}): pool '${reg.pool}' has unexpected type '${info.type}'.`,
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
				yield* setPhase('creating margin pools');
				const tx = new Transaction();
				tx.setGasBudget(500_000_000n);
				const maintainerCap = tx.moveCall({
					target: `${packageId}::margin_registry::mint_maintainer_cap`,
					arguments: [tx.object(registryId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)],
				});
				const coinTypeDataEntries: any[] = [];
				for (const a of resolvedAssets) {
					const coinTypeData = tx.moveCall({
						target: `${packageId}::oracle::new_coin_type_data_from_currency`,
						typeArguments: [a.coinType],
						arguments: [
							tx.object(COIN_REGISTRY_OBJECT_ID),
							tx.pure.vector('u8', fromHex(a.config.feed)),
							tx.pure.u64(a.config.maxConfBps),
							tx.pure.u64(a.config.maxEwmaDifferenceBps),
						],
					});
					coinTypeDataEntries.push(coinTypeData);
				}
				const pythConfig = tx.moveCall({
					target: `${packageId}::oracle::new_pyth_config`,
					arguments: [
						tx.makeMoveVec({ type: `${packageId}::oracle::CoinTypeData`, elements: coinTypeDataEntries }),
						tx.pure.u64(maxAgeSeconds),
					],
				});
				tx.moveCall({
					target: `${packageId}::margin_registry::add_config`,
					typeArguments: [`${packageId}::oracle::PythConfig`],
					arguments: [tx.object(registryId), tx.object(adminCapId), pythConfig],
				});
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
						arguments: [tx.object(registryId), protocolConfig, maintainerCap, tx.object(SUI_CLOCK_OBJECT_ID)],
					});
				}
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
						arguments: [tx.object(registryId), tx.object(adminCapId), tx.object(p.poolId), poolConfig, tx.object(SUI_CLOCK_OBJECT_ID)],
					});
					tx.moveCall({
						target: `${packageId}::margin_registry::enable_deepbook_pool`,
						typeArguments: [p.baseType, p.quoteType],
						arguments: [tx.object(registryId), tx.object(adminCapId), tx.object(p.poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
					});
				}
				tx.transferObjects([maintainerCap], signer.address);
				const result = yield* signer.signAndExecute(tx).pipe(
					Effect.mapError((cause) =>
						new DeepbookError({
							phase: 'margin-pools',
							message: `deepbookMargin(${name}): margin-setup tx failed: ${cause.message}`,
							cause,
						}),
					),
				);
				const marginPools: Array<DeepbookMarginPool> = [];
				for (const a of resolvedAssets) {
					const expected = `${packageId}::margin_pool::MarginPool<${a.coinType}>`;
					const marginPoolId = pickCreatedByType(result.objectChanges, { suffix: expected });
					if (marginPoolId === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'margin-pools',
								marginAsset: a.config.label,
								message: `deepbookMargin(${name}): MarginPool<${a.config.label}> missing from objectChanges (expected ${expected})`,
							}),
						);
					}
					marginPools.push({ label: a.config.label, coinType: a.coinType, marginPoolId });
				}
				const maintainerCapId = pickCreatedByType(result.objectChanges, {
					suffix: `${packageId}::margin_registry::MaintainerCap`,
				});
				const registeredPools = resolvedPools.map((p) => p.poolId);
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
		register: ({ value: m, deps: { marginPublish, liquidationPublish } }) =>
			Effect.gen(function* () {
				const byLabel = new Map(m.marginPools.map((p) => [p.label, p] as const));
				(m as { findMarginPool: (l: string) => DeepbookMarginPool | undefined }).findMarginPool =
					(label) => byLabel.get(label);
				yield* publishPackage({
					name,
					packageId: m.packageId,
					upgradeCapId: marginPublish?.upgradeCapId,
					captured: { registryId: m.registryId, adminCapId: m.adminCapId },
				});
				yield* publishPackage({
					name: `${name}.liquidation`,
					packageId: m.liquidationPackageId,
					upgradeCapId: liquidationPublish?.upgradeCapId,
					captured: {},
				});
				yield* publishDeepbookMarginState({
					name,
					packageId: m.packageId,
					liquidationPackageId: m.liquidationPackageId,
					registryId: m.registryId,
					adminCapId: m.adminCapId,
					...(m.maintainerCapId !== undefined ? { maintainerCapId: m.maintainerCapId } : {}),
					marginPools: m.marginPools.map((p) => ({ label: p.label, assetType: p.coinType, marginPoolId: p.marginPoolId })),
					registeredPools: m.registeredPools,
				});
			}),
	});

	const tagLayer = provide(
		DeepbookMarginTag,
		Effect.gen(function* () {
			return yield* composite;
		}),
	).__layer;

	const __layers = [...composite.__layers, tagLayer];
	return Object.assign(composite, { __layers, __kind: 'action' as const });
};
