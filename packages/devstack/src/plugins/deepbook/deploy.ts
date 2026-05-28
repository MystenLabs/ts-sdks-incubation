// DeepBook local deployment helpers.
//
// The package itself is published by the generic `localPackage(...)` plugin.
// This module owns the DeepBook-specific follow-up transaction: initialize the
// registry's BalanceManager map and create the requested admin pools.

import { createHash } from 'node:crypto';

import { Effect, Schema, type Scope } from 'effect';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import {
	chainId as brandChainId,
	contentHash as brandContentHash,
	type ContentHash,
} from '../../substrate/brand.ts';
import {
	artifactPublishError,
	type ArtifactPublishError,
	type ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import { acquireOnChainArtifact } from '../internal/acquire-on-chain-artifact.ts';
import type { SuiSdkShim } from '../sui/index.ts';
import type { CoinValue } from '../coin/index.ts';
import type { ResolvedSigner } from '../../substrate/runtime/sui-execute/index.ts';
import {
	executeSuiTx,
	formatExecutedFailure,
	isSuiStaleObjectVersionError,
} from '../../substrate/runtime/sui-execute/index.ts';
import { probeManyLenient } from '../../substrate/runtime/probes.ts';
import {
	makeSpacedRetrySchedule,
	STALE_OBJECT_VERSION_RETRY_PROFILE,
} from '../../substrate/runtime/retry-policy.ts';

import { deepbookPluginError, type DeepbookPluginError } from './errors.ts';
import type { DeepbookPhase } from './errors.ts';
import { DeepbookSpans } from './spans.ts';
import type { DeepbookPool, DeepbookPoolSeedLiquidity } from './types.ts';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface DeepbookDeployment {
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly deepTreasuryId?: string | null;
}

type CoinFundingStrategy = NonNullable<CoinValue['fundingStrategy']>;

export interface ResolvedDeepbookPoolSpec {
	readonly name: string;
	readonly base: string;
	readonly quote: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
	readonly baseFundingStrategy?: CoinFundingStrategy;
	readonly quoteFundingStrategy?: CoinFundingStrategy;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
	readonly whitelisted: boolean;
	readonly stablePool: boolean;
	readonly seed?: DeepbookPoolSeedLiquidity;
}

export interface DeepbookPoolsResult {
	readonly pools: ReadonlyArray<DeepbookPool>;
}

export interface DeepbookPoolSeedResult {
	readonly poolName: string;
	readonly balanceManagerId: string;
	readonly digest: string;
}

interface CachedDeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
	readonly tickSize: string;
	readonly lotSize: string;
	readonly minSize: string;
}

interface CachedDeepbookPoolsResult {
	readonly pools: ReadonlyArray<CachedDeepbookPool>;
}

interface CachedDeepbookSeedResult {
	readonly poolName: string;
	readonly balanceManagerId: string;
	readonly digest: string;
}

const CachedDeepbookPoolSchema = Schema.Struct({
	name: Schema.String,
	poolId: Schema.String,
	base: Schema.String,
	quote: Schema.String,
	baseCoinType: Schema.String,
	quoteCoinType: Schema.String,
	tickSize: Schema.String,
	lotSize: Schema.String,
	minSize: Schema.String,
});

const CachedDeepbookPoolsSchema = Schema.Struct({
	pools: Schema.Array(CachedDeepbookPoolSchema),
});

const CachedDeepbookSeedResultSchema = Schema.Struct({
	poolName: Schema.String,
	balanceManagerId: Schema.String,
	digest: Schema.String,
});

const stableContentHash = (input: string): ContentHash =>
	brandContentHash(createHash('sha256').update(input).digest('hex'));

const fromCachedPools = (cached: CachedDeepbookPoolsResult): DeepbookPoolsResult => ({
	pools: cached.pools.map((pool) => ({
		name: pool.name,
		poolId: pool.poolId,
		base: pool.base,
		quote: pool.quote,
		baseCoinType: pool.baseCoinType,
		quoteCoinType: pool.quoteCoinType,
		tickSize: BigInt(pool.tickSize),
		lotSize: BigInt(pool.lotSize),
		minSize: BigInt(pool.minSize),
	})),
});

const toCachedPool = (spec: ResolvedDeepbookPoolSpec, poolId: string): CachedDeepbookPool => ({
	name: spec.name,
	poolId,
	base: spec.base,
	quote: spec.quote,
	baseCoinType: normalizeStructTag(spec.baseCoinType),
	quoteCoinType: normalizeStructTag(spec.quoteCoinType),
	tickSize: spec.tickSize.toString(),
	lotSize: spec.lotSize.toString(),
	minSize: spec.minSize.toString(),
});

const poolInputsHash = (
	pkg: DeepbookDeployment,
	signer: ResolvedSigner,
	pools: ReadonlyArray<ResolvedDeepbookPoolSpec>,
) =>
	stableContentHash(
		[
			'v1',
			pkg.packageId,
			pkg.registryId,
			pkg.adminCapId,
			signer.address,
			...pools
				.map((pool) =>
					[
						pool.name,
						normalizeStructTag(pool.baseCoinType),
						normalizeStructTag(pool.quoteCoinType),
						pool.tickSize.toString(),
						pool.lotSize.toString(),
						pool.minSize.toString(),
						String(pool.whitelisted),
						String(pool.stablePool),
					].join('|'),
				)
				.sort(),
		].join('||'),
	);

const seedInputsHash = (
	pkg: DeepbookDeployment,
	signer: ResolvedSigner,
	spec: ResolvedDeepbookPoolSpec,
	pool: DeepbookPool,
) =>
	stableContentHash(
		[
			'v3',
			pkg.packageId,
			pkg.registryId,
			signer.address,
			spec.name,
			pool.poolId,
			normalizeStructTag(pool.baseCoinType),
			normalizeStructTag(pool.quoteCoinType),
			spec.seed?.baseAmount?.toString() ?? '0',
			spec.seed?.quoteAmount?.toString() ?? '0',
			...(spec.seed?.orders ?? []).map((order, index) =>
				[
					index,
					order.side,
					order.price.toString(),
					order.quantity.toString(),
					order.clientOrderId?.toString() ?? '',
					String(order.payWithDeep ?? false),
				].join('|'),
			),
		].join('||'),
	);

const sdkGetObjectLenient = (
	sdk: SuiSdkShim,
	objectId: string,
): Effect.Effect<unknown | null, never> =>
	Effect.tryPromise({
		try: () => sdk.core.getObject({ objectId }),
		catch: () => null,
	}).pipe(Effect.catch(() => Effect.succeed(null)));

const buildVerifyProbe = (
	sdk: SuiSdkShim,
	cached: CachedDeepbookPoolsResult,
): Effect.Effect<CachedDeepbookPoolsResult | null, never> =>
	Effect.gen(function* () {
		const results = yield* probeManyLenient(
			cached.pools.map((pool) => sdkGetObjectLenient(sdk, pool.poolId)),
		);
		if (results.some((raw) => raw === null || raw === undefined)) return null;
		return cached;
	});

const buildSeedVerifyProbe = (
	sdk: SuiSdkShim,
	cached: CachedDeepbookSeedResult,
): Effect.Effect<CachedDeepbookSeedResult | null, never> =>
	Effect.gen(function* () {
		const raw = yield* sdkGetObjectLenient(sdk, cached.balanceManagerId);
		if (raw === null || raw === undefined) return null;
		return cached;
	});

const findExistingPoolId = (
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	pkg: DeepbookDeployment,
	spec: ResolvedDeepbookPoolSpec,
): Effect.Effect<string | null, never> =>
	Effect.tryPromise({
		try: async () => {
			const tx = new Transaction();
			tx.setSender(signer.address);
			tx.moveCall({
				target: `${pkg.packageId}::pool::get_pool_id_by_asset`,
				typeArguments: [spec.baseCoinType, spec.quoteCoinType],
				arguments: [tx.object(pkg.registryId)],
			});
			const result = await sdk.client.core.simulateTransaction({
				transaction: tx,
				include: { commandResults: true, effects: true },
			});
			const bytes = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
			if (bytes === undefined) return null;
			const normalized = normalizeSuiAddress(bcs.Address.parse(bytes));
			// DeepBook's `get_pool_id_by_asset` returns the all-zeros
			// address when no pool exists for the asset pair (rather
			// than raising). Treat the sentinel as "not found" so the
			// outer create-or-find loop creates the pool instead of
			// adopting `0x0` as a live pool id.
			if (normalized === normalizeSuiAddress('0x0')) return null;
			return normalized;
		},
		catch: () => null,
	}).pipe(Effect.catch(() => Effect.succeed(null)));

const findExistingPools = (
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	pkg: DeepbookDeployment,
	pools: ReadonlyArray<ResolvedDeepbookPoolSpec>,
): Effect.Effect<ReadonlyMap<string, CachedDeepbookPool>, never> =>
	Effect.gen(function* () {
		const found = new Map<string, CachedDeepbookPool>();
		for (const pool of pools) {
			const poolId = yield* findExistingPoolId(sdk, signer, pkg, pool);
			if (poolId !== null) {
				found.set(pool.name, toCachedPool(pool, poolId));
			}
		}
		return found;
	});

const pickCreatedPool = (
	changes: ReadonlyArray<{
		readonly objectId: string;
		readonly objectType?: string;
		readonly idOperation?: string;
	}>,
	spec: ResolvedDeepbookPoolSpec,
): string | null => {
	const base = normalizeStructTag(spec.baseCoinType);
	const quote = normalizeStructTag(spec.quoteCoinType);
	for (const change of changes) {
		const type = change.objectType;
		if (change.idOperation !== 'Created' || type === undefined) continue;
		if (!type.includes('::pool::Pool<')) continue;
		if (type.includes(base) && type.includes(quote)) {
			return change.objectId;
		}
	}
	return null;
};

const mapArtifactError = (phase: DeepbookPhase, err: ArtifactPublishError): DeepbookPluginError =>
	deepbookPluginError(phase, err._tag === 'ArtifactPublishError' ? err.detail : String(err));

const ORDER_TYPE_POST_ONLY = 3;
const SELF_MATCHING_CANCEL_TAKER = 1;
const MAX_TIMESTAMP = 18_446_744_073_709_551_615n;
const SUI_TYPE = normalizeStructTag('0x2::sui::SUI');
const SEED_GAS_BUDGET = 500_000_000n;
const LOCALNET_REFERENCE_GAS_PRICE = 1000n;
/** Retry `executeSuiTx` when the SDK reports a stale object version
 *  (concurrent re-versioning of a shared registry / pool object). The
 *  build closure rebuilds the transaction with fresh refs each attempt;
 *  caps at `STALE_OBJECT_VERSION_RETRY_PROFILE.attempts` so a true
 *  failure surfaces instead of looping forever. */
const executeSuiTxWithStaleObjectRetry = (
	params: Parameters<typeof executeSuiTx>[0],
): ReturnType<typeof executeSuiTx> =>
	executeSuiTx(params).pipe(
		Effect.retry({
			schedule: makeSpacedRetrySchedule(
				STALE_OBJECT_VERSION_RETRY_PROFILE.delayMs,
				STALE_OBJECT_VERSION_RETRY_PROFILE.attempts,
			),
			while: isSuiStaleObjectVersionError,
		}),
	);

// ---------------------------------------------------------------------------
// Create whitelisted pools
// ---------------------------------------------------------------------------

export const createDeepbookPools = (
	publisher: ArtifactPublisher,
	sdk: SuiSdkShim,
	chain: string,
	signer: ResolvedSigner,
	pkg: DeepbookDeployment,
	pools: ReadonlyArray<ResolvedDeepbookPoolSpec>,
): Effect.Effect<DeepbookPoolsResult, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		if (pools.length === 0) return { pools: [] };

		const produced = yield* acquireOnChainArtifact<
			CachedDeepbookPoolsResult,
			CachedDeepbookPoolsResult
		>(publisher, {
			namespace: 'deepbook/pools',
			chain: brandChainId(chain),
			contentHash: poolInputsHash(pkg, signer, pools),
			verifySchema: CachedDeepbookPoolsSchema,
			verify: (cached) => buildVerifyProbe(sdk, cached),
			produce: Effect.gen(function* () {
				const existingPools = yield* findExistingPools(sdk, signer, pkg, pools);
				const missingPools = pools.filter((pool) => !existingPools.has(pool.name));

				const cachedPools: CachedDeepbookPool[] = [];
				if (missingPools.length > 0) {
					const result = yield* executeSuiTx({
						client: sdk.client,
						signer,
						build: async () => {
							const tx = new Transaction();
							tx.setSender(signer.address);
							tx.setGasBudget(500_000_000);
							tx.moveCall({
								target: `${pkg.packageId}::registry::init_balance_manager_map`,
								arguments: [tx.object(pkg.registryId), tx.object(pkg.adminCapId)],
							});
							for (const pool of missingPools) {
								tx.moveCall({
									target: `${pkg.packageId}::pool::create_pool_admin`,
									typeArguments: [pool.baseCoinType, pool.quoteCoinType],
									arguments: [
										tx.object(pkg.registryId),
										tx.pure.u64(pool.tickSize),
										tx.pure.u64(pool.lotSize),
										tx.pure.u64(pool.minSize),
										tx.pure.bool(pool.whitelisted),
										tx.pure.bool(pool.stablePool),
										tx.object(pkg.adminCapId),
									],
								});
							}
							return tx.build({
								client: sdk.client,
							});
						},
					}).pipe(
						Effect.mapError(
							(err): ArtifactPublishError =>
								artifactPublishError(
									'produce-failed',
									`deepbook pool transaction failed: ${err.message}`,
								),
						),
					);
					if (result.$kind === 'FailedTransaction') {
						return yield* Effect.fail(
							artifactPublishError(
								'produce-failed',
								`deepbook pool transaction on-chain execution failed ` +
									formatExecutedFailure(result.FailedTransaction),
							),
						);
					}
					const receipt = result.Transaction;

					for (const pool of missingPools) {
						const poolId = pickCreatedPool(receipt.objectChanges, pool);
						if (poolId === null) {
							return yield* Effect.fail(
								artifactPublishError(
									'produce-failed',
									`deepbook pool '${pool.name}' not found in objectChanges ` +
										`(digest=${receipt.digest}).`,
								),
							);
						}
						cachedPools.push(toCachedPool(pool, poolId));
					}
				}

				return {
					pools: pools
						.map(
							(pool) =>
								existingPools.get(pool.name) ?? cachedPools.find((p) => p.name === pool.name),
						)
						.filter((pool): pool is CachedDeepbookPool => pool !== undefined),
				} satisfies CachedDeepbookPoolsResult;
			}),
		}).pipe(Effect.mapError((err) => mapArtifactError('create-pools', err)));

		const producedPools = new Map(produced.pools.map((pool) => [pool.name, pool]));
		const resolvedPools = pools.map((pool) => producedPools.get(pool.name));
		if (resolvedPools.some((pool) => pool === undefined)) {
			return yield* Effect.fail(
				deepbookPluginError('create-pools', 'deepbook pool creation did not return every pool.'),
			);
		}

		return fromCachedPools({
			pools: resolvedPools.filter((pool): pool is CachedDeepbookPool => pool !== undefined),
		});
	}).pipe(
		Effect.withSpan('devstack.plugin.deepbook.createPools', {
			attributes: {
				[DeepbookSpans.packageId]: pkg.packageId,
				[DeepbookSpans.poolCount]: pools.length,
			},
		}),
	);

// ---------------------------------------------------------------------------
// Seed local liquidity
// ---------------------------------------------------------------------------

const poolByName = (pools: ReadonlyArray<DeepbookPool>, name: string): DeepbookPool | undefined =>
	pools.find((pool) => pool.name === name);

const pickCreatedBalanceManager = (
	changes: ReadonlyArray<{
		readonly objectId: string;
		readonly objectType?: string;
		readonly idOperation?: string;
	}>,
): string | null => {
	for (const change of changes) {
		if (change.idOperation !== 'Created') continue;
		if (change.objectType?.includes('::balance_manager::BalanceManager')) {
			return change.objectId;
		}
	}
	return null;
};

const depositIntoBalanceManager = (
	tx: Transaction,
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	pkg: DeepbookDeployment,
	balanceManager: ReturnType<Transaction['moveCall']>,
	coinType: string,
	amount: bigint | undefined,
) => {
	if (amount === undefined || amount === 0n) return;
	return splitOwnedCoinForBalance(tx, sdk, signer, coinType, amount).then((coin) => {
		tx.moveCall({
			target: `${pkg.packageId}::balance_manager::deposit`,
			typeArguments: [coinType],
			arguments: [balanceManager, coin],
		});
	});
};

const errorDetail = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null) {
		if ('message' in err && typeof err.message === 'string') return err.message;
		if ('detail' in err && typeof err.detail === 'string') return err.detail;
	}
	return String(err);
};

const requestSeedFunding = (
	strategy: CoinFundingStrategy | undefined,
	signer: ResolvedSigner,
	coinType: string,
	amount: bigint | undefined,
): Effect.Effect<void, ArtifactPublishError> => {
	if (strategy === undefined || amount === undefined || amount === 0n) {
		return Effect.void;
	}
	return strategy
		.request({ address: signer.address, amount })
		.pipe(
			Effect.mapError(
				(err): ArtifactPublishError =>
					artifactPublishError(
						'produce-failed',
						`deepbook seed funding failed for ${coinType} ` +
							`to publisher '${signer.name}' amount=${amount}: ${errorDetail(err)}`,
					),
			),
		);
};

interface OwnedCoin {
	readonly objectId: string;
	readonly version: string | number;
	readonly digest: string;
	readonly balance: string | number | bigint;
}

export const selectOwnedCoinsForBalance = async (
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	coinType: string,
	amount: bigint,
	purpose: string,
): Promise<{
	readonly selected: ReadonlyArray<OwnedCoin>;
	readonly selectedBalance: bigint;
}> => {
	const selected: OwnedCoin[] = [];
	let selectedBalance = 0n;
	let cursor: string | null = null;
	do {
		const page = await sdk.client.core.listCoins({
			owner: signer.address,
			coinType,
			cursor,
			limit: 50,
		});
		for (const coin of page.objects) {
			selected.push(coin);
			selectedBalance += BigInt(coin.balance);
			if (selectedBalance >= amount) break;
		}
		cursor = page.cursor;
		if (selectedBalance >= amount) break;
		if (!page.hasNextPage) break;
	} while (cursor !== null);

	if (selectedBalance < amount || selected.length === 0) {
		throw new Error(
			`publisher '${signer.name}' has insufficient ${coinType} for ${purpose}: ` +
				`required ${amount}, available ${selectedBalance}.`,
		);
	}

	return { selected, selectedBalance };
};

// SuiGrpcClient-only surface — `ledgerService.getObject` is NOT on
// `ClientWithCoreApi['core']` (which has `getObject`/`getObjects` with
// a simpler include-options shape). The gRPC-level call returns the
// BCS-encoded object envelope with version + digest in the readMask
// projection, which the `core` surface hides. See @mysten/sui
// `docs/clients/grpc.md` § Ledger service. The `as unknown` is the
// sanctioned escape hatch — `ClientWithCoreApi` doesn't structurally
// overlap with the `{ledgerService}` shape so a direct cast fails.
const ledgerObjectClient = (
	sdk: SuiSdkShim,
): {
	readonly ledgerService: {
		readonly getObject: (args: {
			readonly objectId: string;
			readonly readMask?: { readonly paths: ReadonlyArray<string> };
		}) => Promise<{
			readonly response?: {
				readonly object?: {
					readonly objectId?: string;
					readonly version?: string | number | bigint;
					readonly digest?: string;
				};
			};
		}>;
	};
} =>
	sdk.client as unknown as {
		readonly ledgerService: {
			readonly getObject: (args: {
				readonly objectId: string;
				readonly readMask?: { readonly paths: ReadonlyArray<string> };
			}) => Promise<{
				readonly response?: {
					readonly object?: {
						readonly objectId?: string;
						readonly version?: string | number | bigint;
						readonly digest?: string;
					};
				};
			}>;
		};
	};

const currentLedgerObjectRef = async (
	sdk: SuiSdkShim,
	objectId: string,
): Promise<{
	readonly objectId: string;
	readonly version: string | number;
	readonly digest: string;
}> => {
	const raw = await ledgerObjectClient(sdk).ledgerService.getObject({
		objectId,
		readMask: { paths: ['object_id', 'version', 'digest'] },
	});
	const object = raw.response?.object;
	if (
		object === undefined ||
		object.objectId === undefined ||
		object.version === undefined ||
		object.digest === undefined
	) {
		throw new Error(`object '${objectId}' was not found while resolving a DeepBook seed input.`);
	}
	return {
		objectId: object.objectId,
		version: object.version.toString(),
		digest: object.digest,
	};
};

export const setExplicitSeedGasPayment = async (
	tx: Transaction,
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	suiDepositAmount: bigint,
) => {
	const requiredBalance = SEED_GAS_BUDGET + suiDepositAmount;
	const { selected } = await selectOwnedCoinsForBalance(
		sdk,
		signer,
		SUI_TYPE,
		requiredBalance,
		'DeepBook seed gas and SUI deposits',
	);
	const gasRefs = await Promise.all(
		selected.map((coin) => currentLedgerObjectRef(sdk, coin.objectId)),
	);
	tx.setGasBudget(SEED_GAS_BUDGET);
	tx.setGasPrice(LOCALNET_REFERENCE_GAS_PRICE);
	tx.setGasPayment(gasRefs);
};

const seedSuiDepositAmount = (
	pool: Pick<DeepbookPool, 'baseCoinType' | 'quoteCoinType'>,
	seed: DeepbookPoolSeedLiquidity,
): bigint =>
	(normalizeStructTag(pool.baseCoinType) === SUI_TYPE ? (seed.baseAmount ?? 0n) : 0n) +
	(normalizeStructTag(pool.quoteCoinType) === SUI_TYPE ? (seed.quoteAmount ?? 0n) : 0n);

const sharedObject = async (
	tx: Transaction,
	sdk: SuiSdkShim,
	objectId: string,
	mutable: boolean,
) => {
	const raw = (await sdk.core.getObject({ objectId })) as {
		readonly object?: {
			readonly owner?: {
				readonly Shared?: {
					readonly initialSharedVersion?: string | number;
				};
			};
		};
	};
	const initialSharedVersion = raw.object?.owner?.Shared?.initialSharedVersion;
	if (initialSharedVersion === undefined) {
		throw new Error(`DeepBook object '${objectId}' is not shared.`);
	}
	return tx.sharedObjectRef({
		objectId,
		initialSharedVersion,
		mutable,
	});
};

const splitOwnedCoinForBalance = async (
	tx: Transaction,
	sdk: SuiSdkShim,
	signer: ResolvedSigner,
	coinType: string,
	amount: bigint,
) => {
	if (normalizeStructTag(coinType) === SUI_TYPE) {
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
		return coin;
	}

	const { selected, selectedBalance } = await selectOwnedCoinsForBalance(
		sdk,
		signer,
		coinType,
		amount,
		'DeepBook seed deposit',
	);

	const firstSelected = selected[0];
	if (firstSelected === undefined) {
		throw new Error(
			`publisher '${signer.name}' has no ${coinType} coins for DeepBook seed deposit.`,
		);
	}
	const first = await currentLedgerObjectRef(sdk, firstSelected.objectId);
	const rest = await Promise.all(
		selected.slice(1).map((coin) => currentLedgerObjectRef(sdk, coin.objectId)),
	);
	const baseCoin = tx.objectRef(first);
	if (rest.length > 0) {
		tx.mergeCoins(
			baseCoin,
			rest.map((coin) => tx.objectRef(coin)),
		);
	}
	if (selectedBalance === amount) return baseCoin;
	const [coin] = tx.splitCoins(baseCoin, [tx.pure.u64(amount)]);
	return coin;
};

export const seedDeepbookPools = (
	publisher: ArtifactPublisher,
	sdk: SuiSdkShim,
	chain: string,
	signer: ResolvedSigner,
	pkg: DeepbookDeployment,
	specs: ReadonlyArray<ResolvedDeepbookPoolSpec>,
	pools: ReadonlyArray<DeepbookPool>,
): Effect.Effect<ReadonlyArray<DeepbookPoolSeedResult>, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const seeded: DeepbookPoolSeedResult[] = [];
		for (const spec of specs) {
			const seed = spec.seed;
			if (seed === undefined || seed.orders.length === 0) continue;
			const pool = poolByName(pools, spec.name);
			if (pool === undefined) {
				return yield* Effect.fail(
					deepbookPluginError('create-pools', `deepbook seed pool '${spec.name}' was not created.`),
				);
			}

			const result = yield* acquireOnChainArtifact<
				CachedDeepbookSeedResult,
				CachedDeepbookSeedResult
			>(publisher, {
				namespace: `deepbook/seed/${spec.name}`,
				chain: brandChainId(chain),
				contentHash: seedInputsHash(pkg, signer, spec, pool),
				verifySchema: CachedDeepbookSeedResultSchema,
				verify: (cached) => buildSeedVerifyProbe(sdk, cached),
				produce: Effect.gen(function* () {
						yield* requestSeedFunding(
							spec.baseFundingStrategy,
							signer,
							pool.baseCoinType,
							seed.baseAmount,
						);
						yield* requestSeedFunding(
							spec.quoteFundingStrategy,
							signer,
							pool.quoteCoinType,
							seed.quoteAmount,
						);

						const result = yield* executeSuiTxWithStaleObjectRetry({
							client: sdk.client,
							signer,
							build: async () => {
								const tx = new Transaction();
								tx.setSender(signer.address);
								await setExplicitSeedGasPayment(tx, sdk, signer, seedSuiDepositAmount(pool, seed));
								const registry = await sharedObject(tx, sdk, pkg.registryId, true);
								const poolObject = await sharedObject(tx, sdk, pool.poolId, true);
								const balanceManager = tx.moveCall({
									target: `${pkg.packageId}::balance_manager::new`,
									arguments: [],
								});
								tx.moveCall({
									target: `${pkg.packageId}::balance_manager::register_balance_manager`,
									arguments: [balanceManager, registry],
								});
								await depositIntoBalanceManager(
									tx,
									sdk,
									signer,
									pkg,
									balanceManager,
									pool.baseCoinType,
									seed.baseAmount,
								);
								await depositIntoBalanceManager(
									tx,
									sdk,
									signer,
									pkg,
									balanceManager,
									pool.quoteCoinType,
									seed.quoteAmount,
								);

								const tradeProof = tx.moveCall({
									target: `${pkg.packageId}::balance_manager::generate_proof_as_owner`,
									arguments: [balanceManager],
								});
								for (const [index, order] of seed.orders.entries()) {
									tx.moveCall({
										target: `${pkg.packageId}::pool::place_limit_order`,
										typeArguments: [pool.baseCoinType, pool.quoteCoinType],
										arguments: [
											poolObject,
											balanceManager,
											tradeProof,
											tx.pure.u64(order.clientOrderId ?? BigInt(index + 1)),
											tx.pure.u8(ORDER_TYPE_POST_ONLY),
											tx.pure.u8(SELF_MATCHING_CANCEL_TAKER),
											tx.pure.u64(order.price),
											tx.pure.u64(order.quantity),
											tx.pure.bool(order.side === 'bid'),
											tx.pure.bool(order.payWithDeep ?? false),
											tx.pure.u64(MAX_TIMESTAMP),
											tx.object.clock(),
										],
									});
								}
								tx.transferObjects([balanceManager], signer.address);
								return tx.build({ client: sdk.client });
							},
						}).pipe(
							Effect.mapError(
								(err): ArtifactPublishError =>
									artifactPublishError(
										'produce-failed',
										`deepbook seed transaction failed for pool '${spec.name}': ${err.message}`,
									),
							),
						);
						if (result.$kind === 'FailedTransaction') {
							return yield* Effect.fail(
								artifactPublishError(
									'produce-failed',
									`deepbook seed transaction on-chain execution failed for pool '${spec.name}' ` +
										formatExecutedFailure(result.FailedTransaction),
								),
							);
						}
						const receipt = result.Transaction;

						const balanceManagerId = pickCreatedBalanceManager(receipt.objectChanges);
						if (balanceManagerId === null) {
							return yield* Effect.fail(
								artifactPublishError(
									'produce-failed',
									`deepbook seed BalanceManager not found in objectChanges ` +
										`(digest=${receipt.digest}).`,
								),
							);
						}
						return { poolName: spec.name, balanceManagerId, digest: receipt.digest };
					}),
				}).pipe(Effect.mapError((err) => mapArtifactError('create-pools', err)));

			seeded.push(result);
		}
		return seeded;
	}).pipe(
		Effect.withSpan('devstack.plugin.deepbook.seedPools', {
			attributes: {
				[DeepbookSpans.packageId]: pkg.packageId,
				[DeepbookSpans.poolCount]: specs.filter((spec) => spec.seed !== undefined).length,
			},
		}),
	);
