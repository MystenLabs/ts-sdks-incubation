// `deepbook.market-maker-<name>` — long-running grid-rebalancer
// HostProcess action. On each tick the maker:
//
//   1. Cancels every open order it holds on each pool it quotes.
//   2. Posts a fresh grid of POST_ONLY orders around the configured mid
//      price (`levels` per side, spaced by `tickSpacing * tickSize`,
//      each `sizePerLevel` base units).
//
// First tick on a cold stack also creates the maker's BalanceManager,
// deposits the configured pre-deposit, and registers the resulting
// objectId in `registry.ns('deepbook').balanceManagers`. Subsequent
// ticks (and warm restarts) reuse the cached BM.
//
// HostProcess so `applyTestSetupFilter` skips it in Playwright
// globalSetup; the long-running supervisor (`devstack up`,
// `devstack watch`, `pnpm dev`) owns the loop. If a refresh tx fails
// the tick logs and skips — orders left from a partial failure expire
// via `expireMs` (24 h default) and the next tick retries.

import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';

import {
	type ActionRunContext,
	type LocalnetActionRunContext,
	requireLocalnetCtx,
} from '../../core/types.js';
import { hostProcess } from '../../actions/host-process.js';
import { createLocalSuiClient, openSuiRpcClient } from '../../helpers/sui-client.js';
import { splitInputCoin } from './coin-input.js';
import { resolveCoinType } from './coin-spec.js';
import { type DeepbookPoolSpec, deepbookNs } from './pools.js';

const SUI_CLOCK_OBJECT_ID = '0x6';

// DeepBook v3 `pool::place_limit_order` constants. POST_ONLY rejects
// any order that would cross the book — required for makers; without
// it, the maker would self-take its own bids when it places an ask
// inside the spread on a thin book.
const ORDER_TYPE_POST_ONLY = 3;
const SELF_MATCHING_ALLOWED = 0;

export interface DeepbookMarketMakerSpec {
	/** Action name suffix — `deepbook.market-maker-<name>`. Unique within
	 *  the plugin's `marketMakers:` array. */
	name: string;
	/** Account that owns the BalanceManager + signs each refresh tx. */
	signer: string;
	/** Pool names this maker quotes. Must match `pools[].name` on the
	 *  same `deepbook()` plugin instance. */
	pools: string[];
	/** Cross-plugin dependencies. The base `['pools']` need is always
	 *  present; this field appends. Use it when the maker's signer needs
	 *  funds posted by an earlier setup action — e.g.
	 *  `needs: ['wallet-setup.seedTokens']` so alice owns mUSDC/mWETH
	 *  before the maker tries to deposit them into her BalanceManager. */
	needs?: string[];
	/**
	 * Mid prices keyed by pool name. Static `Record` form is the common
	 * case; the function form lets callers integrate an oracle (e.g.
	 * read a Pyth price from chain) without the plugin caring how the
	 * mid was derived.
	 *
	 * Prices are quoted in DeepBook's pool tick units — same scale as
	 * `tickSize` on the pool spec.
	 */
	midPrices:
		| Record<string, bigint>
		| ((ctx: LocalnetActionRunContext) => Promise<Record<string, bigint>>);
	/** Number of levels per side. Default 3 (so 6 orders total per pool). */
	levels?: number;
	/** Distance between adjacent levels, in `tickSize` units. Default 1
	 *  (orders sit on consecutive ticks). */
	tickSpacing?: number;
	/** Order size per level, in BASE units. Either a single bigint
	 *  (same size on every pool) or per-pool. */
	sizePerLevel: bigint | Record<string, bigint>;
	/** Refresh cadence in ms. Default 10000 (10 s) — matches deepbook-
	 *  sandbox's reference cadence. */
	refreshIntervalMs?: number;
	/**
	 * Pre-deposit amounts per pool. Without this, the BM has no funds
	 * and `place_limit_order` aborts. Default per pool is
	 * `100 * sizePerLevel` of base and `100 * sizePerLevel * mid` of
	 * quote, which covers ~16 refresh ticks of full grid before any
	 * order fills draw it down.
	 */
	preDeposit?: Record<string, { base: bigint; quote: bigint }>;
}

export interface DeepbookMarketMakerActionOptions {
	maker: DeepbookMarketMakerSpec;
	pools: ReadonlyArray<DeepbookPoolSpec>;
}

export function deepbookMarketMakerAction(opts: DeepbookMarketMakerActionOptions) {
	const { maker } = opts;
	const refreshIntervalMs = maker.refreshIntervalMs ?? 10_000;
	const levels = maker.levels ?? 3;
	const tickSpacing = maker.tickSpacing ?? 1;

	const referencedPools = opts.pools.filter((p) => maker.pools.includes(p.name));
	if (referencedPools.length !== maker.pools.length) {
		const missing = maker.pools.filter((n) => !opts.pools.some((p) => p.name === n));
		throw new Error(
			`deepbook.market-maker-${maker.name}: pools ${missing.join(', ')} not declared on plugin`,
		);
	}

	let timer: NodeJS.Timeout | undefined;
	let running = false;

	return hostProcess({
		name: `market-maker-${maker.name}`,
		needs: ['pools', ...(maker.needs ?? [])],
		runsAs: maker.signer,
		inputs: {
			signer: maker.signer,
			pools: maker.pools,
			levels,
			tickSpacing,
			refreshIntervalMs,
		},
		getStatus: async () => {
			if (timer !== undefined) {
				return { ok: true, detail: `maker ${maker.name} loop active` };
			}
			return { ok: false, detail: `maker ${maker.name} not running` };
		},
		run: async (ctx) => {
			requireLocalnetCtx(ctx);
			if (timer !== undefined) return;

			const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));

			// First tick is awaited so getStatus reports `ok` only after the
			// initial grid is on chain. Subsequent ticks are fire-and-log;
			// a failed refresh shouldn't bring the supervisor down.
			await tick(ctx, opts, levels, tickSpacing, log).catch((err) => {
				log(`market-maker-${maker.name}: initial tick failed: ${formatError(err)}`);
			});

			timer = setInterval(() => {
				if (running) return; // skip if previous tick still in flight
				running = true;
				tick(ctx, opts, levels, tickSpacing, log)
					.catch((err) => {
						log(`market-maker-${maker.name}: tick failed: ${formatError(err)}`);
					})
					.finally(() => {
						running = false;
					});
			}, refreshIntervalMs);
			timer.unref();

			ctx.onShutdown?.(async () => {
				if (timer !== undefined) {
					clearInterval(timer);
					timer = undefined;
				}
			});
		},
	});
}

async function tick(
	ctx: LocalnetActionRunContext,
	opts: DeepbookMarketMakerActionOptions,
	levels: number,
	tickSpacing: number,
	log: (line: string) => void,
): Promise<void> {
	const { maker } = opts;
	const ns = deepbookNs(ctx.registry);
	const cached = ns.balanceManagers.find(maker.name);
	const deepbookPkg = ctx.registry.packages.require('deepbook');
	const signer = ctx.accounts.get(maker.signer);
	const signerAddr = signer.toSuiAddress();
	const client = openSuiRpcClient(ctx);

	const referenced = opts.pools.filter((p) => maker.pools.includes(p.name));
	const mids =
		typeof maker.midPrices === 'function' ? await maker.midPrices(ctx) : maker.midPrices;
	for (const spec of referenced) {
		if (mids[spec.name] === undefined) {
			throw new Error(
				`deepbook.market-maker-${maker.name}: midPrices missing entry for pool ${spec.name}`,
			);
		}
	}

	const tx = new Transaction();
	tx.setGasBudget(2_000_000_000);

	let bm: TransactionObjectArgument;
	let creating = false;
	if (cached === undefined) {
		creating = true;
		bm = tx.moveCall({
			target: `${deepbookPkg.packageId}::balance_manager::new`,
			arguments: [],
		});
		await depositPreDeposits(ctx, tx, bm, signerAddr, deepbookPkg.packageId, opts, mids, client);
	} else {
		bm = tx.object(cached.objectId);
	}

	const proof = tx.moveCall({
		target: `${deepbookPkg.packageId}::balance_manager::generate_proof_as_owner`,
		arguments: [bm],
	});

	const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
	let clientOrderId = Math.floor(Date.now() / 1000); // monotonic-ish, distinct across ticks
	for (const spec of referenced) {
		const cachedPool = ns.pools.require(spec.name);
		if (!creating) {
			tx.moveCall({
				target: `${deepbookPkg.packageId}::pool::cancel_all_orders`,
				typeArguments: [cachedPool.baseCoinType, cachedPool.quoteCoinType],
				arguments: [tx.object(cachedPool.poolId), bm, proof, tx.object(SUI_CLOCK_OBJECT_ID)],
			});
		}

		const mid = mids[spec.name]!;
		const sizeBase = resolveSizePerLevel(maker.sizePerLevel, spec.name);
		for (let i = 1; i <= levels; i++) {
			for (const isBid of [true, false] as const) {
				const offset = spec.tickSize * BigInt(i * tickSpacing);
				const price = isBid ? mid - offset : mid + offset;
				if (price <= 0n) continue; // pathological mid; skip the bid
				tx.moveCall({
					target: `${deepbookPkg.packageId}::pool::place_limit_order`,
					typeArguments: [cachedPool.baseCoinType, cachedPool.quoteCoinType],
					arguments: [
						tx.object(cachedPool.poolId),
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
			`deepbook.market-maker-${maker.name}: tx failed: ${
				result.effects?.status?.error ?? 'unknown'
			}`,
		);
	}
	await client.waitForTransaction({ digest: result.digest });

	if (creating) {
		const bmType = `${deepbookPkg.packageId}::balance_manager::BalanceManager`;
		const bmObj = (result.objectChanges ?? []).find(
			(c) => c.type === 'created' && 'objectType' in c && c.objectType === bmType,
		);
		if (bmObj === undefined || bmObj.type !== 'created') {
			throw new Error(`deepbook.market-maker-${maker.name}: BalanceManager id missing`);
		}
		ns.balanceManagers.register({
			name: maker.name,
			objectId: bmObj.objectId,
			owner: signerAddr,
		});
		log(
			`market-maker-${maker.name}: created BM ${bmObj.objectId} + initial grid (${
				referenced.length
			} pool${referenced.length === 1 ? '' : 's'}, ${levels} level${levels === 1 ? '' : 's'})`,
		);
	} else {
		log(
			`market-maker-${maker.name}: rebalanced ${referenced.length} pool${
				referenced.length === 1 ? '' : 's'
			} (${levels} level${levels === 1 ? '' : 's'}/side)`,
		);
	}
}

async function depositPreDeposits(
	ctx: ActionRunContext,
	tx: Transaction,
	bm: TransactionObjectArgument,
	owner: string,
	deepbookPackageId: string,
	opts: DeepbookMarketMakerActionOptions,
	mids: Record<string, bigint>,
	client: ReturnType<typeof createLocalSuiClient>,
): Promise<void> {
	const { maker } = opts;
	const referenced = opts.pools.filter((p) => maker.pools.includes(p.name));

	// Aggregate by coin type: SUI on `tx.gas`; non-SUI by listCoins +
	// merge + split. Multiple pools may share a base/quote coin type
	// (e.g. SUI base across both `sui_usdc` and `sui_weth`); deposit
	// the union per coin type with a single `coin::split`.
	const totalsByCoinType = new Map<string, bigint>();
	for (const spec of referenced) {
		const baseType = resolveCoinType(ctx.registry, spec.base);
		const quoteType = resolveCoinType(ctx.registry, spec.quote);
		const sizeBase = resolveSizePerLevel(maker.sizePerLevel, spec.name);
		const mid = mids[spec.name]!;
		const explicit = maker.preDeposit?.[spec.name];
		const baseAmount = explicit?.base ?? 100n * sizeBase;
		// Quote amount must cover bids: roughly `levels * sizeBase * mid /
		// scale`, but DeepBook prices are already in the pool's base-units
		// scaling (see plugin docs). 100x sizeBase * mid is generous.
		const quoteAmount = explicit?.quote ?? (100n * sizeBase * mid) / 1_000_000_000n + 1n;
		totalsByCoinType.set(baseType, (totalsByCoinType.get(baseType) ?? 0n) + baseAmount);
		totalsByCoinType.set(quoteType, (totalsByCoinType.get(quoteType) ?? 0n) + quoteAmount);
	}

	for (const [coinType, amount] of totalsByCoinType) {
		const coin = await splitInputCoin({
			tx,
			client,
			owner,
			coinType,
			amount,
			errorPrefix: 'market-maker',
		});
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
		throw new Error(`market-maker: sizePerLevel missing entry for pool ${poolName}`);
	}
	return v;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
