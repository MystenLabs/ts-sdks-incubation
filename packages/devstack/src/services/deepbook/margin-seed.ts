// `deepbookMarginSeed(opts)` — mint a SupplierCap + supply seed
// liquidity to each margin pool. Mirrors sandbox parity
// (`~/code/deepbook-sandbox/sandbox/scripts/utils/pool.ts:459-584`).
//
// State-store cache at `deepbook/margin-seed/<chainId>/<marginPackageId>/<signer>/<amountsHash>`
// records `{digest, supplierCapId, seededAmounts}` so a resume short-
// circuits the supply tx. Best-effort verification on resume — we
// re-fetch the SupplierCap by id and ensure it still exists owned by
// signer; mismatch invalidates.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { tag, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { pickCreatedByType } from '../../engine/sui-helpers.js';
import { StateStore } from '../../engine/state-store.js';
import { StateStoreKeys } from '../../engine/state-store-keys.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { DeepbookError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import type { DeepbookMargin } from './margin.js';
import { MARGIN_SUPPLIER_CAP_TYPE_SUFFIX, SUI_CLOCK_OBJECT_ID } from './internal.js';

// State-store key prefix for margin-seed moved to
// `engine/state-store-keys.ts`. Canonical builder:
// `StateStoreKeys.deepbookMarginSeed({chainId, packageId, trailing})`
// where `trailing` is the `${signer.address}/${amountsHash}` suffix.

// Sui-native coin type — special-cased in the seed body so the supply
// tx splits SUI from `tx.gas` rather than searching for owned coin
// objects (matches sandbox parity).
const SUI_COIN_TYPE = '0x2::sui::SUI';

/** One per-asset seed amount entry. `amount` is the raw on-chain
 *  amount (already scaled by the asset's coin decimals) — the caller
 *  multiplies by the asset's scalar before passing in. */
export interface DeepbookMarginSeedAmount {
	readonly label: string;
	readonly amount: bigint;
}

export interface DeepbookMarginSeedOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	readonly margin: LayeredTag<any, DeepbookMargin, any, any>;
	readonly amounts: ReadonlyArray<DeepbookMarginSeedAmount>;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

export interface DeepbookMarginSeedResult {
	readonly digest: string;
	readonly supplierCapId: string;
	readonly seededAmounts: ReadonlyArray<DeepbookMarginSeedAmount>;
}

interface CachedMarginSeed {
	readonly digest: string;
	readonly supplierCapId: string;
	readonly seededAmounts: ReadonlyArray<{
		readonly label: string;
		readonly amount: string;
	}>;
}

// Stable hash over the amounts payload — keys sorted, bigints rendered
// as decimal strings. Matches the cache key contract used elsewhere.
const hashSeedAmounts = (amounts: ReadonlyArray<DeepbookMarginSeedAmount>): string => {
	const canonical = amounts
		.slice()
		.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
		.map((a) => ({ label: a.label, amount: a.amount.toString() }));
	return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
};

export const deepbookMarginSeed = <const Name extends string = 'deepbook-margin-seed'>(
	options: DeepbookMarginSeedOptions<Name>,
) => {
	const name = (options.name ?? 'deepbook-margin-seed') as Name;

	// Validate the per-label uniqueness up front; the body uses label
	// keys to look up margin pools and would silently overwrite on a
	// duplicate.
	const seen = new Set<string>();
	for (const a of options.amounts) {
		if (seen.has(a.label)) {
			throw new TypeError(`deepbookMarginSeed: duplicate amount label '${a.label}'`);
		}
		seen.add(a.label);
		if (a.amount <= 0n) {
			throw new TypeError(
				`deepbookMarginSeed: amount for '${a.label}' must be > 0 (got ${a.amount})`,
			);
		}
	}

	const composite = tag(
		name,
		Effect.gen(function* () {
			for (const dep of options.dependsOn ?? []) {
				yield* dep;
			}

			const sui = yield* SuiTag;
			const signer = yield* options.signer;
			const margin = yield* options.margin;
			const state = yield* StateStore;

			yield* Effect.annotateCurrentSpan({ 'sui.chainId': sui.chainId });
			yield* setPhase('seeding margin pools');

			// Resolve each amount entry to the matching margin pool
			// (label → pool record). Sandbox parity: per-asset seeding
			// happens against the per-label MarginPool object.
			interface ResolvedSeed {
				readonly amount: bigint;
				readonly label: string;
				readonly coinType: string;
				readonly marginPoolId: string;
			}
			const resolved: Array<ResolvedSeed> = [];
			for (const a of options.amounts) {
				const pool = margin.findMarginPool(a.label);
				if (pool === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-seed',
							marginAsset: a.label,
							message:
								`deepbookMarginSeed(${name}): margin pool for asset '${a.label}' is not ` +
								`declared on the configured deepbookMargin Ref. Add the asset to ` +
								`\`deepbookMargin({ assets: [...] })\` first.`,
						}),
					);
				}
				resolved.push({
					amount: a.amount,
					label: a.label,
					coinType: pool.coinType,
					marginPoolId: pool.marginPoolId,
				});
			}

			const amountsHash = hashSeedAmounts(options.amounts);
			const cacheKey = StateStoreKeys.deepbookMarginSeed({
				chainId: sui.chainId,
				packageId: margin.packageId,
				trailing: `${signer.address}/${amountsHash}`,
			});
			const cached = yield* state.get<CachedMarginSeed>(cacheKey);

			const verifyCached = (payload: CachedMarginSeed) =>
				Effect.gen(function* () {
					const fetched = yield* Effect.tryPromise({
						try: () => sui.client.core.getObject({ objectId: payload.supplierCapId }),
						catch: (cause) => cause,
					}).pipe(
						Effect.map((res) => res as unknown as { objectType?: unknown }),
						Effect.orElseSucceed(() => undefined),
					);
					if (fetched === undefined) return false;
					const actualType =
						typeof fetched.objectType === 'string' ? fetched.objectType : undefined;
					if (actualType === undefined) return false;
					return actualType.endsWith(MARGIN_SUPPLIER_CAP_TYPE_SUFFIX);
				});

			if (Option.isSome(cached)) {
				const verified = yield* verifyCached(cached.value);
				if (verified) {
					yield* Effect.logInfo(
						`deepbookMarginSeed(${name}): cache hit — ` +
							`packageId=${margin.packageId} amountsHash=${amountsHash}`,
					);
					yield* Effect.annotateCurrentSpan({
						'deepbook.margin-seed.cache': 'hit',
						'deepbook.margin-seed.hash': amountsHash,
					});
					return {
						digest: cached.value.digest,
						supplierCapId: cached.value.supplierCapId,
						seededAmounts: cached.value.seededAmounts.map((a) => ({
							label: a.label,
							amount: BigInt(a.amount),
						})),
					} satisfies DeepbookMarginSeedResult;
				}
				yield* Effect.logInfo(
					`deepbookMarginSeed(${name}): cache hit but SupplierCap missing on chain — ` +
						`invalidating and re-seeding (chainId=${sui.chainId} packageId=${margin.packageId})`,
				);
				yield* Effect.annotateCurrentSpan({
					'deepbook.margin-seed.cache': 'stale',
					'deepbook.margin-seed.hash': amountsHash,
				});
				yield* state.remove(cacheKey);
			} else {
				yield* Effect.annotateCurrentSpan({
					'deepbook.margin-seed.cache': 'miss',
					'deepbook.margin-seed.hash': amountsHash,
				});
			}

			yield* setPhase('building seed tx');
			const tx = new Transaction();
			tx.setGasBudget(500_000_000n);

			// 1) mint_supplier_cap → captured for downstream supply calls
			const supplierCap = tx.moveCall({
				target: `${margin.packageId}::margin_pool::mint_supplier_cap`,
				arguments: [tx.object(margin.registryId), tx.object(SUI_CLOCK_OBJECT_ID)],
			});

			// 2) per-asset supply. SUI is special-cased: split from
			// `tx.gas` so the SDK's coin resolver doesn't consume every
			// owned SUI coin as a deposit source. Other coins (USDC,
			// etc.) flow through `tx.coin({ balance, type, useGasCoin:
			// true })` which the SDK resolves at submission time
			// against the signer's owned coins of that type.
			for (const r of resolved) {
				let coin;
				if (r.coinType === SUI_COIN_TYPE) {
					coin = tx.splitCoins(tx.gas, [tx.pure.u64(r.amount)]);
				} else {
					coin = tx.coin({
						balance: r.amount,
						type: r.coinType,
						useGasCoin: true,
					});
				}
				tx.moveCall({
					target: `${margin.packageId}::margin_pool::supply`,
					typeArguments: [r.coinType],
					arguments: [
						tx.object(r.marginPoolId),
						tx.object(margin.registryId),
						supplierCap,
						coin,
						// Optional referral address — `None` mirrors sandbox parity.
						tx.pure(bcs.option(bcs.Address).serialize(null)),
						tx.object(SUI_CLOCK_OBJECT_ID),
					],
				});
			}

			// 3) transfer SupplierCap to signer
			tx.transferObjects([supplierCap], signer.address);

			const result = yield* signer.signAndExecute(tx).pipe(
				Effect.mapError(
					(cause) =>
						new DeepbookError({
							phase: 'margin-seed',
							message: `deepbookMarginSeed(${name}): seed tx failed: ${cause.message}`,
							cause,
						}),
				),
			);

			// Extract the captured SupplierCap object id.
			const supplierCapId = pickCreatedByType(result.objectChanges, {
				suffix: MARGIN_SUPPLIER_CAP_TYPE_SUFFIX,
			});
			if (supplierCapId === undefined) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'margin-seed',
						message:
							`deepbookMarginSeed(${name}): SupplierCap not found in objectChanges ` +
							`after seed tx (digest=${result.digest})`,
					}),
				);
			}

			const seededAmounts = options.amounts.map((a) => ({ label: a.label, amount: a.amount }));
			const toCache: CachedMarginSeed = {
				digest: result.digest,
				supplierCapId,
				seededAmounts: seededAmounts.map((a) => ({
					label: a.label,
					amount: a.amount.toString(),
				})),
			};
			yield* state.put(cacheKey, toCache);

			return {
				digest: result.digest,
				supplierCapId,
				seededAmounts,
			} satisfies DeepbookMarginSeedResult;
		}).pipe(
			Effect.withSpan(`DeepbookMarginSeed(${name})`),
			Effect.catchTag('DeepbookError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookError({
						phase: 'margin-seed',
						message: `deepbookMarginSeed(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'action' as const,
			displayTitle: `deepbook.margin.seed.${name}`,
			display: (s: DeepbookMarginSeedResult) => ({
				title: `deepbook.margin.seed.${name}`,
				primary: s.supplierCapId,
				extras: [`${s.seededAmounts.length} pool${s.seededAmounts.length === 1 ? '' : 's'}`],
			}),
			// The body yields SuiTag, the signer Account ref, and the
			// margin composite, plus iterates `dependsOn`. Lift them so
			// the topo
			// scheduler places this composite strictly after all providers.
			upstreamKeys: [SuiTag.key, options.signer, options.margin, ...(options.dependsOn ?? [])],
		},
	);

	return Object.assign(composite, { __kind: 'action' as const });
};
