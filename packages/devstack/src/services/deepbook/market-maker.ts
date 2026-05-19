// `deepbookMarketMaker(opts)` — long-running grid market-maker.
// Composes against `DeepbookCoreTag` regardless of which factory provided
// it (local-deploy or known-package), then forks a refresh loop into
// the surrounding scope.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Option, Schedule } from 'effect';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { StateStore } from '../../engine/state-store.js';
import { DeepbookError } from '../../engine/errors.js';
import { DeepbookCoreTag, type DeepbookPoolRef } from '../deepbook.js';
import type { Account } from '../../engine/shared.js';
import {
	ORDER_TYPE_POST_ONLY,
	SELF_MATCHING_ALLOWED,
	SUI_CLOCK_OBJECT_ID,
	calculateGridLevels,
	depositPreDeposits,
	resolveCoinRef,
	type AnyCoinTag,
} from './internal.js';

// StateStore key prefix for the cached BalanceManager id. The pool name
// is appended as a final segment so each pool's BM caches independently
// (D4: per-pool is the only mode). Folds in `chainId` (regenesis ⇒
// miss), the deepbook `packageId` (republish ⇒ miss — the cached
// BalanceManager belongs to the old package's type universe), and the
// signer address (per-account isolation).
//
// Without this cache, every supervisor restart minted a fresh
// BalanceManager — the closure state in the previous fiber went away
// with the scope. Old BalanceManagers orphaned + held locked funds, and
// the audit caught it.
const STATE_KEY_BALANCE_MANAGER_PREFIX = 'deepbook/market-maker/balance-manager/v2';

interface CachedBalanceManager {
	readonly balanceManagerId: string;
}

// Grid strategy. `bps` (basis points) drives the offset from a
// multiplicative spread + level spacing, mirroring the deepbook-sandbox
// grid maker (D3). `kind` discriminator is retained so future
// strategies can be added without rewriting callsites.
export type DeepbookMarketMakerStrategy = {
	readonly kind: 'bps';
	/** Levels per side. Default 30 (sandbox parity). */
	readonly levels?: number;
	/** Spread from mid in basis points (1 bp = 0.01%). Default 10. */
	readonly spreadBps?: number;
	/** Distance between adjacent levels in basis points. Default 100. */
	readonly levelSpacingBps?: number;
};

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
	 *  Each tick reposts a POST_ONLY grid centred here.
	 *
	 *  Function form is re-evaluated each tick — pass `() => currentMid`
	 *  if you want price to track an external feed (e.g. an oracle Ref
	 *  observed via a SynchronizedRef) without restarting the
	 *  supervisor. The `bigint` form is captured once at construction
	 *  and works for static grids. */
	readonly midPrice: bigint | (() => bigint);
	/** Order size per level in BASE units. Same dynamic-vs-static
	 *  semantics as `midPrice`. */
	readonly sizePerLevel: bigint | (() => bigint);
	/** Optional per-pool predeposit override. Without an override the maker
	 *  deposits `100 * sizePerLevel` base + the quote-equivalent at
	 *  `midPrice`. */
	readonly preDeposit?: { readonly base: bigint; readonly quote: bigint };
	/** Optional per-pool lot-size, used to align order sizes for `bps`
	 *  strategy (mirrors sandbox's `alignToLotSize`). Defaults to 1n. */
	readonly lotSize?: bigint;
}

export interface DeepbookMarketMakerHandle {
	/** Always 0 — the maker runs as an in-process Effect fiber rather
	 *  than an OS subprocess, so there's no real pid. Kept for shape
	 *  parity with a future hostProcess variant. */
	readonly pid: number;
}

export interface DeepbookMarketMakerOptions<Name extends string> {
	readonly name: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	readonly pools: ReadonlyArray<DeepbookMarketMakerPoolSpec>;
	/** Grid placement strategy. Discriminated by `kind`. Required —
	 *  no implicit default per D3. */
	readonly strategy: DeepbookMarketMakerStrategy;
	/** Refresh cadence in ms. Default 10_000 (10 s). */
	readonly refreshMs?: number;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

/**
 * Long-running grid market-maker. Composes against `DeepbookCoreTag`
 * regardless of which factory provided it (local-deploy or
 * known-package), then forks a refresh loop into the surrounding scope.
 */
export const deepbookMarketMaker = <const Name extends string>(
	options: DeepbookMarketMakerOptions<Name>,
) =>
	tag(
		options.name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			const sui = yield* SuiTag;
			const signer = yield* options.signer;
			const core = yield* DeepbookCoreTag;
			const state = yield* StateStore;

			const strategy: DeepbookMarketMakerStrategy = options.strategy;
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

			// BalanceManager bookkeeping. One id per pool name (D4: per-pool
			// is the only mode). Mutable closure state rather than a Ref
			// since the fiber is single-threaded and we don't read it from
			// outside the loop.
			//
			// Resume idempotency: pre-load cached ids from the state-store
			// keyed by `(chainId, packageId, signer.address, poolName)`. On
			// a cache hit we verify the object is still on chain and only
			// then trust it — otherwise mint a fresh one. Cache writes after
			// the first successful mint are best-effort; a state-store IO
			// defect must not crash the maker after the BalanceManager already
			// settled on chain.
			const baseKey = `${STATE_KEY_BALANCE_MANAGER_PREFIX}/${sui.chainId}/${core.packageId}/${signer.address}`;
			const balanceManagerIds: Map<string, string> = new Map();

			const cacheKeyFor = (poolName: string): string => `${baseKey}/${poolName}`;

			const verifyOnChain = (candidate: string): Effect.Effect<boolean, never> =>
				Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId: candidate }),
					catch: (cause) => cause,
				}).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);

			// Pre-load any cached ids, one per pool name. Mutates
			// `balanceManagerIds` so the tick loop's "creating?" check fires
			// the right number of `balance_manager::new` calls per tick.
			for (const { spec } of quotedPools) {
				const key = cacheKeyFor(spec.name);
				const cached = yield* state.get<CachedBalanceManager>(key);
				if (Option.isSome(cached)) {
					const candidate = cached.value.balanceManagerId;
					const verified = yield* verifyOnChain(candidate);
					if (verified) {
						yield* Effect.annotateCurrentSpan({
							[`deepbook.marketMaker.balanceManager.${spec.name}.cache`]: 'hit',
							[`deepbook.marketMaker.balanceManager.${spec.name}`]: candidate,
						});
						balanceManagerIds.set(spec.name, candidate);
					} else {
						yield* Effect.annotateCurrentSpan({
							[`deepbook.marketMaker.balanceManager.${spec.name}.cache`]: 'stale',
						});
						yield* state.remove(key).pipe(Effect.ignore);
					}
				} else {
					yield* Effect.annotateCurrentSpan({
						[`deepbook.marketMaker.balanceManager.${spec.name}.cache`]: 'miss',
					});
				}
			}

			// Compute grid offsets for a single (mid, tickSize, lotSize)
			// triple. For `bps` it's `mid * (spreadBps + i * levelSpacingBps)
			// / 10_000` aligned to `tickSize`. Returns an array of
			// `[price, sizeBase]` pairs per side; consumers iterate over
			// both bid and ask.
			const computeOffsets = (
				mid: bigint,
				sizeBase: bigint,
				tickSize: bigint,
				lotSize: bigint,
			): {
				readonly bids: ReadonlyArray<{ price: bigint; size: bigint }>;
				readonly asks: ReadonlyArray<{ price: bigint; size: bigint }>;
			} =>
				calculateGridLevels({
					mid,
					sizeBase,
					tickSize,
					lotSize,
					levels: strategy.levels ?? 30,
					spreadBps: strategy.spreadBps ?? 10,
					levelSpacingBps: strategy.levelSpacingBps ?? 100,
				});

			const tickOnce = Effect.gen(function* () {
				const t = new Transaction();
				t.setGasBudget(2_000_000_000n);

				// Decide per-pool which BMs are being newly created on this
				// tick (so we emit `balance_manager::new` + pre-deposit
				// once) vs. reused. One BM per pool (D4).
				// Mutable maps from pool name to TransactionObjectArgument
				// so each pool's order placement can look up its own BM ref
				// inside the tx.
				const bmArgs = new Map<string, TransactionObjectArgument>();
				const proofArgs = new Map<string, TransactionObjectArgument>();
				const newlyCreated = new Set<string>();

				for (const { spec } of quotedPools) {
					if (bmArgs.has(spec.name)) continue;
					const creating = !balanceManagerIds.has(spec.name);
					if (creating) {
						const bm = t.moveCall({
							target: `${core.packageId}::balance_manager::new`,
							arguments: [],
						});
						bmArgs.set(spec.name, bm);
						newlyCreated.add(spec.name);
					} else {
						bmArgs.set(spec.name, t.object(balanceManagerIds.get(spec.name)!));
					}
				}

				// Pre-deposit math runs only for newly-created BMs. Each
				// pool's inventory deposits into its own BM.
				if (newlyCreated.size > 0) {
					for (const { spec, pool } of quotedPools) {
						if (!newlyCreated.has(spec.name)) continue;
						const bm = bmArgs.get(spec.name)!;
						depositPreDeposits({
							t,
							bm,
							packageId: core.packageId,
							quotedPools: [
								{
									pool,
									spec: {
										sizePerLevel:
											typeof spec.sizePerLevel === 'function'
												? spec.sizePerLevel()
												: spec.sizePerLevel,
										midPrice:
											typeof spec.midPrice === 'function'
												? spec.midPrice()
												: spec.midPrice,
										preDeposit: spec.preDeposit,
									},
								},
							],
						});
					}
				}

				// Generate proofs per BM ref — one per pool.
				for (const [key, bm] of bmArgs) {
					const proof = t.moveCall({
						target: `${core.packageId}::balance_manager::generate_proof_as_owner`,
						arguments: [bm],
					});
					proofArgs.set(key, proof);
				}

				const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
				let clientOrderId = Math.floor(Date.now() / 1000);

				for (const { spec, pool } of quotedPools) {
					const bm = bmArgs.get(spec.name)!;
					const proof = proofArgs.get(spec.name)!;
					const wasCreated = newlyCreated.has(spec.name);

					if (!wasCreated) {
						t.moveCall({
							target: `${core.packageId}::pool::cancel_all_orders`,
							typeArguments: [pool.baseType, pool.quoteType],
							arguments: [t.object(pool.poolId), bm, proof, t.object(SUI_CLOCK_OBJECT_ID)],
						});
					}

					// C9: re-resolve the dynamic fields each tick.
					const mid = typeof spec.midPrice === 'function' ? spec.midPrice() : spec.midPrice;
					const sizeBase =
						typeof spec.sizePerLevel === 'function' ? spec.sizePerLevel() : spec.sizePerLevel;
					const tickSize = spec.tickSize;
					const lotSize = spec.lotSize ?? 1n;

					const { bids, asks } = computeOffsets(mid, sizeBase, tickSize, lotSize);

					const placeOne = (price: bigint, size: bigint, isBid: boolean): void => {
						if (price <= 0n) return;
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
								t.pure.u64(size),
								t.pure.bool(isBid),
								// pay_with_deep — whitelisted pool waives DEEP fees.
								t.pure.bool(false),
								t.pure.u64(expireMs),
								t.object(SUI_CLOCK_OBJECT_ID),
							],
						});
					};

					for (const { price, size } of bids) placeOne(price, size, true);
					for (const { price, size } of asks) placeOne(price, size, false);
				}

				// Transfer ownership for each newly-minted BM back to the
				// signer at the end of the tx. With `shared` this is one
				// call; with `perPool` one per new pool.
				for (const key of newlyCreated) {
					t.transferObjects([bmArgs.get(key)!], signer.address);
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

				if (newlyCreated.size > 0) {
					const bmType = `${core.packageId}::balance_manager::BalanceManager`;
					// `pickCreatedByType` with the default (first-match) form
					// returns one id; we need all of them when multiple BMs
					// were minted on an initial tick. Walk the created changes
					// manually rather than threading `{ prefix, all }` here —
					// the filter would need both the type AND the tick-window
					// constraint anyway.
					const createdBmIds = result.objectChanges
						.filter(
							(c): c is Extract<typeof c, { type: 'created' }> =>
								c.type === 'created' &&
								'objectType' in c &&
								typeof c.objectType === 'string' &&
								c.objectType === bmType,
						)
						.map((c) => c.objectId);

					if (createdBmIds.length < newlyCreated.size) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'market-maker-tick',
								message:
									`deepbookMarketMaker(${options.name}): expected ${newlyCreated.size} ` +
									`BalanceManager ids from objectChanges, got ${createdBmIds.length}`,
							}),
						);
					}

					// Order of `createdBmIds` matches the order BMs were
					// created in the tx — which is the order we iterated
					// `newlyCreated` (Set preserves insertion order). Map
					// 1:1.
					let i = 0;
					for (const poolName of newlyCreated) {
						const bmId = createdBmIds[i++]!;
						balanceManagerIds.set(poolName, bmId);
						yield* state
							.put(cacheKeyFor(poolName), {
								balanceManagerId: bmId,
							} satisfies CachedBalanceManager)
							.pipe(Effect.ignore);
					}
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
			// rather than a silent skipped loop.
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

// Export the bps state-store key prefix so tests can assert key shape
// changes between v1 and v2 without re-deriving the string. Kept off the
// public API surface — internal cache contract.
export const STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL = STATE_KEY_BALANCE_MANAGER_PREFIX;
