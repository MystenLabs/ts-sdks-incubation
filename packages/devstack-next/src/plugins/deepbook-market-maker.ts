// `deepbookMarketMaker` — long-running DeepBook v3 grid market-maker.
// Each tick the maker:
//
//   1. Cancels every open order it holds on each pool it quotes.
//   2. Posts a fresh grid of POST_ONLY orders around the configured mid
//      price (`levels` per side, spaced by `tickSpacing * tickSize`,
//      each `sizePerLevel` base units).
//
// First tick on a cold stack also creates the maker's BalanceManager,
// deposits the configured pre-deposit, and persists the BM id into the
// producer's state. Subsequent ticks (and warm restarts) reuse the
// cached BM via `prior.balanceManagerId`.
//
// Skipped by Playwright globalSetup (which uses `setupForTest` →
// `engine.runOnce()` without entering the long-running cycle); only
// the `devstack up` supervisor + `pnpm dev` flow start the interval.
// Mechanical port of old devstack's deepbook/market-maker.ts — same
// Move calls, same fee math, same cadence.

import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import type { Dep, Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from './sui.js';
import type { DeepbookPoolEntry, DeepbookPoolsState } from './deepbook.js';
import type { PublishState } from '../helpers/publish-move.js';

const SUI_CLOCK_OBJECT_ID = '0x6';

// DeepBook v3 `pool::place_limit_order` constants. POST_ONLY rejects
// any order that would cross the book — required for makers; without
// it a maker would self-take its own bids when it places an ask
// inside the spread on a thin book.
const ORDER_TYPE_POST_ONLY = 3;
const SELF_MATCHING_ALLOWED = 0;

export interface DeepbookMarketMakerOptions {
	/** Producer name suffix — node becomes `deepbook.market-maker.<name>`.
	 *  Must be unique within the stack. */
	name: string;
	/** Account that owns the BalanceManager + signs each refresh tx. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signer: Dep<any, Keypair>;
	/** The published deepbook package Dep — typically
	 *  `deepbookLocalnet({...}).publish.get('package')`. Provides the
	 *  package id for every Move call this maker issues. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	deepbookPackage: Dep<any, { packageId: string }>;
	/** Pool entries Dep — typically
	 *  `deepbookLocalnet({...}).pools!.get('full')`. The maker filters
	 *  this list down to `quotedPools` to find pool ids + coin types. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pools: Dep<any, DeepbookPoolsState>;
	/** Names of pools this maker quotes (subset of `pools` above). */
	quotedPools: string[];
	/**
	 * Mid prices keyed by pool name. Static `Record` form is the common
	 * case; the function form lets callers integrate an oracle (read a
	 * Pyth price from chain) without the producer caring how the mid
	 * was derived. Prices are quoted in the pool's tick units (same
	 * scale as `tickSize` on the pool spec).
	 */
	midPrices:
		| Record<string, bigint>
		| ((ctx: { rpcUrl: string; env: Env }) => Promise<Record<string, bigint>>);
	/** Number of levels per side. Default 3 (so 6 orders total per pool). */
	levels?: number;
	/** Distance between adjacent levels in `tickSize` units. Default 1. */
	tickSpacing?: number;
	/** Order size per level in BASE units. Single bigint or per-pool. */
	sizePerLevel: bigint | Record<string, bigint>;
	/** Refresh cadence in ms. Default 10_000 (10 s). */
	refreshIntervalMs?: number;
	/**
	 * Pre-deposit amounts per pool. Without this, the BM has no funds
	 * and `place_limit_order` aborts. Default per pool is
	 * `100 * sizePerLevel` of base and `100 * sizePerLevel * mid /
	 * 1_000_000_000` of quote, which covers ~16 refresh ticks of the
	 * full grid before any order fills draw it down.
	 */
	preDeposit?: Record<string, { base: bigint; quote: bigint }>;
}

export interface DeepbookMarketMakerState {
	/** Set after the first successful tick — the BalanceManager object
	 *  id the maker owns. Warm restarts use this to skip BM creation. */
	balanceManagerId?: string;
	/** Last successful tick wall-clock (ms). Useful for diagnostics. */
	lastTickAt?: number;
}

const provides = {
	state: dep((s: DeepbookMarketMakerState) => s),
	balanceManagerId: dep((s: DeepbookMarketMakerState) => s.balanceManagerId),
} satisfies Provides<DeepbookMarketMakerState>;

interface ResolvedMakerDeps {
	signer: Keypair;
	deepbookPackage: { packageId: string } | PublishState;
	pools: DeepbookPoolsState;
	rpc: { url: string };
}

export function deepbookMarketMaker(opts: DeepbookMarketMakerOptions) {
	if (!opts.name) throw new Error('deepbookMarketMaker: `name` is required');
	if (opts.quotedPools.length === 0) {
		throw new Error(`deepbookMarketMaker('${opts.name}'): \`quotedPools\` cannot be empty`);
	}

	const refreshIntervalMs = opts.refreshIntervalMs ?? 10_000;
	const levels = opts.levels ?? 3;
	const tickSpacing = opts.tickSpacing ?? 1;

	const deps = {
		signer: opts.signer,
		deepbookPackage: opts.deepbookPackage,
		pools: opts.pools,
		rpc: sui.get('rpc'),
	};

	return define<DeepbookMarketMakerState, typeof provides, typeof deps>({
		name: `deepbook.market-maker.${opts.name}`,
		deps,
		provides,
		runsAs: `deepbook.market-maker.${opts.name}`,
		inputs: ({ deps }) => {
			const resolved = deps as ResolvedMakerDeps;
			return {
				deepbookPackageId: resolved.deepbookPackage.packageId,
				quotedPools: [...opts.quotedPools].sort(),
				levels,
				tickSpacing,
				refreshIntervalMs,
				// Mid prices fold in when static; function form runs every
				// tick anyway so we don't gate the input hash on it.
				midPrices:
					typeof opts.midPrices === 'function'
						? '[function]'
						: Object.fromEntries(
								Object.entries(opts.midPrices).map(([k, v]) => [k, v.toString()]),
							),
			};
		},
		start: async ({ deps, prior, log, onShutdown, env }): Promise<DeepbookMarketMakerState> => {
			const resolved = deps as ResolvedMakerDeps;
			const quotedPoolEntries = resolved.pools.pools.filter((p) =>
				opts.quotedPools.includes(p.name),
			);
			if (quotedPoolEntries.length !== opts.quotedPools.length) {
				const missing = opts.quotedPools.filter(
					(n) => !resolved.pools.pools.some((p) => p.name === n),
				);
				throw new Error(
					`deepbook.market-maker.${opts.name}: pools ${missing.join(', ')} not in deepbookLocalnet pools state`,
				);
			}

			let balanceManagerId = prior?.balanceManagerId;
			let timer: NodeJS.Timeout | undefined;
			let running = false;

			const fire = async (): Promise<void> => {
				const result = await tick({
					opts,
					deps: resolved,
					quotedPoolEntries,
					levels,
					tickSpacing,
					balanceManagerId,
					env,
				});
				if (result.createdBalanceManagerId !== undefined) {
					balanceManagerId = result.createdBalanceManagerId;
				}
			};

			// First tick is awaited so failures surface as a producer error
			// rather than a silent skipped loop.
			try {
				await fire();
				log(
					balanceManagerId === undefined
						? `market-maker-${opts.name}: initial tick — BM creation incoming`
						: `market-maker-${opts.name}: initial grid posted (BM ${balanceManagerId})`,
				);
			} catch (err) {
				throw new Error(
					`deepbook.market-maker.${opts.name}: initial tick failed: ${formatError(err)}`,
					{ cause: err },
				);
			}

			timer = setInterval(() => {
				if (running) return; // previous tick still in flight; skip
				running = true;
				fire()
					.catch((err) => {
						log(`market-maker-${opts.name}: tick failed: ${formatError(err)}`);
					})
					.finally(() => {
						running = false;
					});
			}, refreshIntervalMs);
			timer.unref();

			onShutdown(async () => {
				if (timer !== undefined) {
					clearInterval(timer);
					timer = undefined;
				}
			});

			const out: DeepbookMarketMakerState = { lastTickAt: Date.now() };
			if (balanceManagerId !== undefined) out.balanceManagerId = balanceManagerId;
			return out;
		},
	});
}

interface TickArgs {
	opts: DeepbookMarketMakerOptions;
	deps: ResolvedMakerDeps;
	quotedPoolEntries: DeepbookPoolEntry[];
	levels: number;
	tickSpacing: number;
	balanceManagerId: string | undefined;
	env: Env;
}

async function tick(args: TickArgs): Promise<{ createdBalanceManagerId?: string }> {
	const { opts, deps, quotedPoolEntries, levels, tickSpacing, balanceManagerId, env } = args;
	const deepbookPackageId = deps.deepbookPackage.packageId;
	const signer = deps.signer;
	const signerAddr = signer.toSuiAddress();
	const client = new SuiJsonRpcClient({ url: deps.rpc.url, network: 'localnet' });

	const mids =
		typeof opts.midPrices === 'function'
			? await opts.midPrices({ rpcUrl: deps.rpc.url, env })
			: opts.midPrices;
	for (const spec of quotedPoolEntries) {
		if (mids[spec.name] === undefined) {
			throw new Error(
				`deepbook.market-maker.${opts.name}: midPrices missing entry for pool ${spec.name}`,
			);
		}
	}

	const tx = new Transaction();
	tx.setGasBudget(2_000_000_000);

	let bm: TransactionObjectArgument;
	const creating = balanceManagerId === undefined;
	if (creating) {
		bm = tx.moveCall({
			target: `${deepbookPackageId}::balance_manager::new`,
			arguments: [],
		});
		depositPreDeposits({ tx, bm, opts, mids, quotedPoolEntries, deepbookPackageId, signerAddr });
	} else {
		bm = tx.object(balanceManagerId);
	}

	const proof = tx.moveCall({
		target: `${deepbookPackageId}::balance_manager::generate_proof_as_owner`,
		arguments: [bm],
	});

	const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
	let clientOrderId = Math.floor(Date.now() / 1000);
	for (const spec of quotedPoolEntries) {
		if (!creating) {
			tx.moveCall({
				target: `${deepbookPackageId}::pool::cancel_all_orders`,
				typeArguments: [spec.baseCoinType, spec.quoteCoinType],
				arguments: [tx.object(spec.poolId), bm, proof, tx.object(SUI_CLOCK_OBJECT_ID)],
			});
		}

		const mid = mids[spec.name]!;
		const sizeBase = resolveSizePerLevel(opts.sizePerLevel, spec.name);
		const tickSize = BigInt(spec.tickSize);
		for (let i = 1; i <= levels; i++) {
			for (const isBid of [true, false] as const) {
				const offset = tickSize * BigInt(i * tickSpacing);
				const price = isBid ? mid - offset : mid + offset;
				if (price <= 0n) continue;
				tx.moveCall({
					target: `${deepbookPackageId}::pool::place_limit_order`,
					typeArguments: [spec.baseCoinType, spec.quoteCoinType],
					arguments: [
						tx.object(spec.poolId),
						bm,
						proof,
						tx.pure.u64(BigInt(clientOrderId++)),
						tx.pure.u8(ORDER_TYPE_POST_ONLY),
						tx.pure.u8(SELF_MATCHING_ALLOWED),
						tx.pure.u64(price),
						tx.pure.u64(sizeBase),
						tx.pure.bool(isBid),
						tx.pure.bool(false), // pay_with_deep — whitelisted pool waives
						tx.pure.u64(expireMs),
						tx.object(SUI_CLOCK_OBJECT_ID),
					],
				});
			}
		}
	}

	if (creating) {
		tx.transferObjects([bm], signerAddr);
	}

	const result = await client.signAndExecuteTransaction({
		signer,
		transaction: tx,
		options: { showEffects: true, showObjectChanges: creating },
	});
	if (result.effects?.status?.status !== 'success') {
		throw new Error(
			`deepbook.market-maker.${opts.name}: tx failed: ${
				result.effects?.status?.error ?? 'unknown'
			}`,
		);
	}
	await client.waitForTransaction({ digest: result.digest });

	if (!creating) return {};

	const bmType = `${deepbookPackageId}::balance_manager::BalanceManager`;
	const bmObj = (result.objectChanges ?? []).find(
		(c: SuiObjectChange) => c.type === 'created' && 'objectType' in c && c.objectType === bmType,
	);
	if (bmObj === undefined || bmObj.type !== 'created') {
		throw new Error(`deepbook.market-maker.${opts.name}: BalanceManager id missing`);
	}
	return { createdBalanceManagerId: bmObj.objectId };
}

interface DepositArgs {
	tx: Transaction;
	bm: TransactionObjectArgument;
	opts: DeepbookMarketMakerOptions;
	mids: Record<string, bigint>;
	quotedPoolEntries: DeepbookPoolEntry[];
	deepbookPackageId: string;
	signerAddr: string;
}

function depositPreDeposits(args: DepositArgs): void {
	const { tx, bm, opts, mids, quotedPoolEntries, deepbookPackageId } = args;

	const totalsByCoinType = new Map<string, bigint>();
	for (const spec of quotedPoolEntries) {
		const sizeBase = resolveSizePerLevel(opts.sizePerLevel, spec.name);
		const mid = mids[spec.name]!;
		const explicit = opts.preDeposit?.[spec.name];
		const baseAmount = explicit?.base ?? 100n * sizeBase;
		const quoteAmount = explicit?.quote ?? (100n * sizeBase * mid) / 1_000_000_000n + 1n;
		totalsByCoinType.set(
			spec.baseCoinType,
			(totalsByCoinType.get(spec.baseCoinType) ?? 0n) + baseAmount,
		);
		totalsByCoinType.set(
			spec.quoteCoinType,
			(totalsByCoinType.get(spec.quoteCoinType) ?? 0n) + quoteAmount,
		);
	}

	for (const [coinType, amount] of totalsByCoinType) {
		// `tx.coin({ balance, type, useGasCoin: false })` — SDK resolver
		// picks address-balance withdrawal when the sender's accumulator
		// has enough, owned coin objects otherwise. Same helper old
		// devstack's deepbook/coin-input.ts used; inlined to avoid a
		// one-line module.
		const coin = tx.coin({ balance: amount, type: coinType, useGasCoin: false });
		tx.moveCall({
			target: `${deepbookPackageId}::balance_manager::deposit`,
			typeArguments: [coinType],
			arguments: [bm, coin],
		});
	}
}

function resolveSizePerLevel(
	size: bigint | Record<string, bigint>,
	poolName: string,
): bigint {
	if (typeof size === 'bigint') return size;
	const v = size[poolName];
	if (v === undefined) {
		throw new Error(`deepbookMarketMaker: sizePerLevel missing entry for pool ${poolName}`);
	}
	return v;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
