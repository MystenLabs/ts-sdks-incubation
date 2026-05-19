// `deepbookMarginSeed(opts)` — mint a SupplierCap + supply seed
// liquidity to each margin pool. Mirrors sandbox parity
// (`~/code/deepbook-sandbox/sandbox/scripts/utils/pool.ts:459-584`).
//
// Phase C migration: routes through `onChainArtifact` so the cache
// discipline + ChainProbe-based verify probe match the canonical Phase
// B template (`services/package/internal.ts`). Cache namespace is the
// bare `deepbook/margin-seed` string; `chainId` + `inputsHash`
// distinguish instances (B7 fix: verify probe uses
// `ChainProbe.getObject` to confirm the cached SupplierCap still
// exists AND its objectType ends with the canonical
// `::margin_pool::SupplierCap` suffix — the pre-Phase-C verify cast a
// raw `client.core.getObject` response through `as unknown as
// { objectType? }` and would silently mask a `{type: undefined}` SDK
// shape drift).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { setPhase, type LayeredTag } from '../../advanced/tag.js';
import { pickCreatedByType } from '../../engine/sui-helpers.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { onChainArtifact } from '../../engine/on-chain-artifact.js';
import { DeepbookError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import type { DeepbookMargin } from './margin.js';
import { MARGIN_SUPPLIER_CAP_TYPE_SUFFIX, SUI_CLOCK_OBJECT_ID } from './internal.js';

const SUI_COIN_TYPE = '0x2::sui::SUI';

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

export const deepbookMarginSeed = <const Name extends string = 'deepbook-margin-seed'>(
	options: DeepbookMarginSeedOptions<Name>,
) => {
	const name = (options.name ?? 'deepbook-margin-seed') as Name;
	const seen = new Set<string>();
	for (const a of options.amounts) {
		if (seen.has(a.label)) {
			throw new TypeError(`deepbookMarginSeed: duplicate amount label '${a.label}'`);
		}
		seen.add(a.label);
		if (a.amount <= 0n) {
			throw new TypeError(`deepbookMarginSeed: amount for '${a.label}' must be > 0 (got ${a.amount})`);
		}
	}
	const dependsOn = options.dependsOn ?? [];
	const depEntries: Record<string, LayeredTag<any, any, any, any>> = {};
	for (let i = 0; i < dependsOn.length; i++) depEntries[`dep${i}`] = dependsOn[i]!;

	return onChainArtifact({
		name,
		kind: 'action',
		plugin: 'deepbook',
		displayTitle: `deepbook.margin.seed.${name}`,
		display: (s: DeepbookMarginSeedResult) => ({
			title: `deepbook.margin.seed.${name}`,
			primary: s.supplierCapId,
			extras: [`${s.seededAmounts.length} pool${s.seededAmounts.length === 1 ? '' : 's'}`],
		}),
		upstream: { signer: options.signer, margin: options.margin, ...depEntries },
		namespace: 'deepbook/margin-seed',
		label: `deepbookMarginSeed(${name})`,
		inputs: ({ signer, margin }) =>
			Effect.succeed({
				signer: signer.address,
				packageId: margin.packageId,
				amounts: options.amounts
					.slice()
					.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
					.map((a) => ({ label: a.label, amount: a.amount.toString() })),
			}),
		verify: ({ cached, chain }) =>
			chain.getObject(cached.supplierCapId).pipe(
				Effect.map((info) =>
					info !== undefined && info.type.endsWith(MARGIN_SUPPLIER_CAP_TYPE_SUFFIX)
						? cached
						: undefined,
				),
			),
		produce: ({ signer, margin }) =>
			Effect.gen(function* () {
				yield* setPhase('seeding margin pools');
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
									`declared on the configured deepbookMargin Ref.`,
							}),
						);
					}
					resolved.push({ amount: a.amount, label: a.label, coinType: pool.coinType, marginPoolId: pool.marginPoolId });
				}
				yield* setPhase('building seed tx');
				const tx = new Transaction();
				tx.setGasBudget(500_000_000n);
				const supplierCap = tx.moveCall({
					target: `${margin.packageId}::margin_pool::mint_supplier_cap`,
					arguments: [tx.object(margin.registryId), tx.object(SUI_CLOCK_OBJECT_ID)],
				});
				for (const r of resolved) {
					let coin;
					if (r.coinType === SUI_COIN_TYPE) {
						coin = tx.splitCoins(tx.gas, [tx.pure.u64(r.amount)]);
					} else {
						coin = tx.coin({ balance: r.amount, type: r.coinType, useGasCoin: true });
					}
					tx.moveCall({
						target: `${margin.packageId}::margin_pool::supply`,
						typeArguments: [r.coinType],
						arguments: [
							tx.object(r.marginPoolId),
							tx.object(margin.registryId),
							supplierCap,
							coin,
							tx.pure(bcs.option(bcs.Address).serialize(null)),
							tx.object(SUI_CLOCK_OBJECT_ID),
						],
					});
				}
				tx.transferObjects([supplierCap], signer.address);
				const result = yield* signer.signAndExecute(tx).pipe(
					Effect.mapError((cause) =>
						new DeepbookError({
							phase: 'margin-seed',
							message: `deepbookMarginSeed(${name}): seed tx failed: ${cause.message}`,
							cause,
						}),
					),
				);
				const supplierCapId = pickCreatedByType(result.objectChanges, { suffix: MARGIN_SUPPLIER_CAP_TYPE_SUFFIX });
				if (supplierCapId === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'margin-seed',
							message: `deepbookMarginSeed(${name}): SupplierCap not found in objectChanges (digest=${result.digest})`,
						}),
					);
				}
				const seededAmounts = options.amounts.map((a) => ({ label: a.label, amount: a.amount }));
				return { digest: result.digest, supplierCapId, seededAmounts } satisfies DeepbookMarginSeedResult;
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
	});
};
