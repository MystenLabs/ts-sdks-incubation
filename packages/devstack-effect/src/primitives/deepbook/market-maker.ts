// `deepbookMarketMaker(opts)` — long-running grid market-maker.
// Composes against `DeepbookCore` regardless of which factory provided
// it (local-deploy or known-package), then forks a refresh loop into
// the surrounding scope.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Schedule } from 'effect';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { makeTag, type PluginTag } from '../../tag.js';
import { Sui } from '../sui.js';
import { stringifyCause } from '../../internal/stringify-cause.js';
import { DeepbookError } from '../errors.js';
import { DeepbookCore, type DeepbookPoolRef } from '../../interfaces/deepbook.js';
import type { Account, SuiObjectChange } from '../shared.js';
import {
	ORDER_TYPE_POST_ONLY,
	SELF_MATCHING_ALLOWED,
	SUI_CLOCK_OBJECT_ID,
	depositPreDeposits,
	resolveCoinRef,
	type AnyCoinTag,
} from './internal.js';

export interface DeepbookMarketMakerPoolSpec<
	Base extends string | AnyCoinTag = string | AnyCoinTag,
	Quote extends string | AnyCoinTag = string | AnyCoinTag,
> {
	readonly name: string;
	/** Move type or coin tag for the base asset. Tag form resolved before
	 *  the first tick — yielding the tag here also pins it as a dependency
	 *  edge in the layer graph. */
	readonly base: Base;
	readonly quote: Quote;
	readonly tickSize: bigint;
	/** Mid price in the pool's quote units (same scale as `tickSize`).
	 *  Each tick reposts a POST_ONLY grid centred here. */
	readonly midPrice: bigint;
	/** Order size per level in BASE units. */
	readonly sizePerLevel: bigint;
	/** Optional per-pool predeposit override. Without an override the maker
	 *  deposits `100 * sizePerLevel` base + the quote-equivalent at
	 *  `midPrice`. */
	readonly preDeposit?: { readonly base: bigint; readonly quote: bigint };
}

export interface DeepbookMarketMakerHandle {
	/** Always 0 — the maker runs as an in-process Effect fiber rather
	 *  than an OS subprocess, so there's no real pid. Kept for shape
	 *  parity with the v3 plugin / future hostProcess variant. */
	readonly pid: number;
}

export interface DeepbookMarketMakerOptions<Name extends string> {
	readonly name: Name;
	readonly signer: PluginTag<any, Account, any, any>;
	readonly pools: ReadonlyArray<DeepbookMarketMakerPoolSpec>;
	/** Levels per side. Default 3 (so 6 orders per pool per tick). */
	readonly levels?: number;
	/** Distance between adjacent levels in `tickSize` units. Default 1. */
	readonly tickSpacing?: number;
	/** Refresh cadence in ms. Default 10_000 (10 s). */
	readonly refreshMs?: number;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
}

/**
 * Long-running grid market-maker. Composes against `DeepbookCore`
 * regardless of which factory provided it (local-deploy or
 * known-package), then forks a refresh loop into the surrounding scope.
 */
export const deepbookMarketMaker = <const Name extends string>(
	options: DeepbookMarketMakerOptions<Name>,
) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			yield* Sui;
			const signer = yield* options.signer;
			const core = yield* DeepbookCore;

			const levels = options.levels ?? 3;
			const tickSpacing = options.tickSpacing ?? 1;
			const refreshMs = options.refreshMs ?? 10_000;

			if (options.pools.length === 0) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'market-maker-tick',
						message: `deepbookMarketMaker(${options.name}): \`pools\` cannot be empty`,
					}),
				);
			}

			// Resolve coin-tag refs up-front so the inner tick loop runs
			// against plain Move-type strings. Yielding the tags here also
			// pins them as dependency edges in the layer graph.
			const quotedPools = yield* Effect.gen(function* () {
				const out: Array<{
					readonly spec: DeepbookMarketMakerPoolSpec;
					readonly pool: DeepbookPoolRef;
				}> = [];
				for (const spec of options.pools) {
					const base = yield* resolveCoinRef(spec.base);
					const quote = yield* resolveCoinRef(spec.quote);
					const pool = yield* core.findPool({ base, quote });
					out.push({ spec, pool });
				}
				return out;
			});

			// BalanceManager id is minted on the first tick (matches v3's
			// behavior); subsequent ticks reuse it. Mutable closure state
			// rather than a Ref since the fiber is single-threaded and we
			// don't read it from outside the loop.
			let balanceManagerId: string | undefined;

			const tickOnce = Effect.gen(function* () {
				const creating = balanceManagerId === undefined;
				const t = new Transaction();
				t.setGasBudget(2_000_000_000n);

				let bm: TransactionObjectArgument;
				if (creating) {
					bm = t.moveCall({
						target: `${core.packageId}::balance_manager::new`,
						arguments: [],
					});
					depositPreDeposits({
						t,
						bm,
						packageId: core.packageId,
						quotedPools,
					});
				} else {
					bm = t.object(balanceManagerId!);
				}

				const proof = t.moveCall({
					target: `${core.packageId}::balance_manager::generate_proof_as_owner`,
					arguments: [bm],
				});

				const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
				let clientOrderId = Math.floor(Date.now() / 1000);

				for (const { spec, pool } of quotedPools) {
					if (!creating) {
						t.moveCall({
							target: `${core.packageId}::pool::cancel_all_orders`,
							typeArguments: [pool.baseType, pool.quoteType],
							arguments: [t.object(pool.poolId), bm, proof, t.object(SUI_CLOCK_OBJECT_ID)],
						});
					}

					const mid = spec.midPrice;
					const sizeBase = spec.sizePerLevel;
					const tickSize = spec.tickSize;

					for (let i = 1; i <= levels; i++) {
						for (const isBid of [true, false] as const) {
							const offset = tickSize * BigInt(i * tickSpacing);
							const price = isBid ? mid - offset : mid + offset;
							if (price <= 0n) continue;
							t.moveCall({
								target: `${core.packageId}::pool::place_limit_order`,
								typeArguments: [pool.baseType, pool.quoteType],
								arguments: [
									t.object(pool.poolId),
									bm,
									proof,
									t.pure.u64(BigInt(clientOrderId++)),
									t.pure.u8(ORDER_TYPE_POST_ONLY),
									t.pure.u8(SELF_MATCHING_ALLOWED),
									t.pure.u64(price),
									t.pure.u64(sizeBase),
									t.pure.bool(isBid),
									// pay_with_deep — whitelisted pool waives DEEP fees.
									t.pure.bool(false),
									t.pure.u64(expireMs),
									t.object(SUI_CLOCK_OBJECT_ID),
								],
							});
						}
					}
				}

				if (creating) {
					t.transferObjects([bm], signer.address);
				}

				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new DeepbookError({
								phase: 'market-maker-tick',
								message: `deepbookMarketMaker(${options.name}): tick tx failed: ${cause.message}`,
								cause,
							}),
					),
				);

				if (creating) {
					const bmType = `${core.packageId}::balance_manager::BalanceManager`;
					const bmObj = result.objectChanges.find(
						(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
							c.type === 'created' && 'objectType' in c && c.objectType === bmType,
					);
					if (bmObj === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'market-maker-tick',
								message:
									`deepbookMarketMaker(${options.name}): BalanceManager id missing ` +
									`from objectChanges after creation tick`,
							}),
						);
					}
					balanceManagerId = bmObj.objectId;
				}
			}).pipe(Effect.withSpan('deepbookMarketMaker.tick'));

			// Transient failures (a single bad tx, a temporarily-unreachable
			// RPC) shouldn't kill the maker — log + continue on the next
			// schedule tick. The fiber only exits when the surrounding scope
			// closes.
			const loopOnce = tickOnce.pipe(
				Effect.catch((cause: unknown) =>
					Effect.logWarning(
						`deepbookMarketMaker(${options.name}): tick failed: ${stringifyCause(cause)}`,
					),
				),
			);

			// First tick runs synchronously inside the producer so a
			// configuration error (bad pool ref) surfaces as a startup failure
			// rather than a silent skipped loop. Matches v3's `await fire()`
			// before kicking off setInterval.
			yield* tickOnce.pipe(
				Effect.mapError(
					(cause) =>
						new DeepbookError({
							phase: 'market-maker-tick',
							message: `deepbookMarketMaker(${options.name}): initial tick failed: ${cause.message}`,
							cause,
						}),
				),
			);

			yield* Effect.forkScoped(loopOnce.pipe(Effect.repeat(Schedule.spaced(refreshMs))));

			return { pid: 0 } satisfies DeepbookMarketMakerHandle;
		}).pipe(
			Effect.withSpan(`deepbookMarketMaker(${options.name})`),
			Effect.catchTag('DeepbookError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookError({
						phase: 'deepbookMarketMaker',
						message: `deepbookMarketMaker(${options.name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'service',
			displayTitle: `deepbook.${options.name}`,
			display: () => ({
				title: `deepbook.${options.name}`,
				primary: `${options.pools.length} pool${options.pools.length === 1 ? '' : 's'}`,
			}),
		},
	);
