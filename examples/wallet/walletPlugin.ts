// Wallet's app plugin. Owns:
//
//   wallet.usdc       — Publish mock_usdc Move package; register tokens.musdc.
//   wallet.weth       — Publish mock_weth Move package; register tokens.mweth.
//   wallet.seedTokens — publisher mints the initial USDC + WETH supply to
//                       alice/bob/carol per the configured distribution.
//   wallet.seedPools  — publisher (deepbook admin) registers the
//                       BalanceManagerMap and creates SUI/mUSDC + SUI/mWETH
//                       whitelisted pools (no DEEP fees on swap).
//   wallet.seedOrders — alice creates a fresh BalanceManager, deposits SUI/
//                       mUSDC/mWETH, and posts 6 limit orders per pool so
//                       swaps in the UI have something to take.
//
// DeepBook v3 itself is imported by the shared `imports` plugin (declared
// in devstack.config.ts). The seed actions below resolve it via
// `registry.packages.require('deepbook')` and depend on `imports.deepbook`
// in their `needs:` so the topo sorter places them after the import.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type Registry,
	type RegistryQuery,
	definePlugin,
	definePublishAction,
	seed,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient } from '@mysten-incubation/devstack/helpers';
import { Transaction } from '@mysten/sui/transactions';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');

const SUI_COIN_TYPE = '0x2::sui::SUI';
const SUI_CLOCK_OBJECT_ID = '0x6';

// DeepBook constants from `deepbook::constants`. Used in seedOrders.
const ORDER_TYPE_NO_RESTRICTION = 0;
const SELF_MATCHING_ALLOWED = 0;

// Initial token distributions (raw units, accounting for decimals).
const USDC_DISTRIBUTION: ReadonlyArray<{ recipient: string; amount: bigint }> = [
	{ recipient: 'alice', amount: 25_000_000_000n }, // 25,000 USDC (6 dec)
	{ recipient: 'bob', amount: 10_000_000_000n }, // 10,000 USDC
	{ recipient: 'carol', amount: 5_000_000_000n }, // 5,000 USDC
];
const WETH_DISTRIBUTION: ReadonlyArray<{ recipient: string; amount: bigint }> = [
	{ recipient: 'alice', amount: 1_000_000_000n }, // 10 WETH (8 dec)
	{ recipient: 'bob', amount: 500_000_000n }, // 5 WETH
	{ recipient: 'carol', amount: 200_000_000n }, // 2 WETH
];

interface PoolSpec {
	name: string;
	baseCoinKey: 'sui' | 'mock_usdc' | 'mock_weth';
	quoteCoinKey: 'sui' | 'mock_usdc' | 'mock_weth';
	tickSize: bigint;
	lotSize: bigint;
	minSize: bigint;
}

const POOLS: ReadonlyArray<PoolSpec> = [
	{
		name: 'sui_usdc',
		baseCoinKey: 'sui',
		quoteCoinKey: 'mock_usdc',
		tickSize: 1_000n, // 0.001 mUSDC per SUI (quote, 6 dec)
		lotSize: 100_000_000n, // 0.1 SUI step (base, 9 dec)
		minSize: 1_000_000_000n, // 1 SUI minimum (base, 9 dec)
	},
	{
		name: 'sui_weth',
		baseCoinKey: 'sui',
		quoteCoinKey: 'mock_weth',
		tickSize: 100n, // 0.000001 mWETH per SUI (quote, 8 dec)
		lotSize: 100_000_000n, // 0.1 SUI step (base, 9 dec)
		minSize: 1_000_000_000n, // 1 SUI minimum (base, 9 dec)
	},
];

export interface WalletPool {
	name: string;
	poolId: string;
	objectType: string;
	baseCoinType: string;
	quoteCoinType: string;
}

export interface WalletBalanceManager {
	name: string;
	objectId: string;
	owner: string;
}

export interface WalletNamespace {
	pools: RegistryQuery<WalletPool>;
	balanceManager: RegistryQuery<WalletBalanceManager>;
}

export const walletPlugin = () =>
	definePlugin({
		name: 'wallet',
		actions: () => [
			definePublishAction({
				name: 'usdc',
				needs: ['sui.accounts'],
				registryAs: 'mock_usdc',
				sourcePath: USDC_DIR,
				capture: {
					treasuryCapId: '::coin::TreasuryCap<',
					metadataId: '::coin::CoinMetadata<',
					upgradeCapId: '0x2::package::UpgradeCap',
				},
				onPublished: (ctx, result) => {
					ctx.registry.tokens.register({
						name: 'musdc',
						type: `${result.packageId}::mock_usdc::MOCK_USDC`,
						decimals: 6,
					});
				},
			}),
			definePublishAction({
				name: 'weth',
				needs: ['sui.accounts'],
				registryAs: 'mock_weth',
				sourcePath: WETH_DIR,
				capture: {
					treasuryCapId: '::coin::TreasuryCap<',
					metadataId: '::coin::CoinMetadata<',
					upgradeCapId: '0x2::package::UpgradeCap',
				},
				onPublished: (ctx, result) => {
					ctx.registry.tokens.register({
						name: 'mweth',
						type: `${result.packageId}::mock_weth::MOCK_WETH`,
						decimals: 8,
					});
				},
			}),
			seed({
				name: 'seedTokens',
				needs: ['usdc', 'weth'],
				inputs: {
					usdc: USDC_DISTRIBUTION.map((d) => ({ ...d, amount: d.amount.toString() })),
					weth: WETH_DISTRIBUTION.map((d) => ({ ...d, amount: d.amount.toString() })),
				},
				getStatus: async (ctx) => {
					const usdc = ctx.registry.packages.find('mock_usdc');
					const weth = ctx.registry.packages.find('mock_weth');
					if (usdc === undefined || weth === undefined) {
						return { ok: false, detail: 'mock packages not registered' };
					}
					const accounts = ctx.registry.accounts;
					const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
					for (const { recipient, amount } of USDC_DISTRIBUTION) {
						const addr = accounts.find(recipient)?.address;
						if (addr === undefined) return { ok: false, detail: `${recipient} not in registry` };
						const bal = await client.getBalance({
							owner: addr,
							coinType: `${usdc.packageId}::mock_usdc::MOCK_USDC`,
						});
						if (BigInt(bal.totalBalance) < amount) {
							return { ok: false, detail: `${recipient} mUSDC balance below seed` };
						}
					}
					for (const { recipient, amount } of WETH_DISTRIBUTION) {
						const addr = accounts.find(recipient)?.address;
						if (addr === undefined) return { ok: false, detail: `${recipient} not in registry` };
						const bal = await client.getBalance({
							owner: addr,
							coinType: `${weth.packageId}::mock_weth::MOCK_WETH`,
						});
						if (BigInt(bal.totalBalance) < amount) {
							return { ok: false, detail: `${recipient} mWETH balance below seed` };
						}
					}
					return { ok: true, detail: 'distributions intact' };
				},
				run: async (ctx) => {
					const publisher = ctx.accounts.get('publisher');
					const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
					const usdc = ctx.registry.packages.require('mock_usdc');
					const weth = ctx.registry.packages.require('mock_weth');
					const usdcCap = usdc.captured.treasuryCapId;
					const wethCap = weth.captured.treasuryCapId;
					if (usdcCap === undefined || wethCap === undefined) {
						throw new Error('wallet.seedTokens: TreasuryCap ids missing from manifest');
					}

					const tx = new Transaction();
					tx.setGasBudget(500_000_000);
					for (const { recipient, amount } of USDC_DISTRIBUTION) {
						const addr = ctx.registry.accounts.require(recipient).address;
						tx.moveCall({
							target: `${usdc.packageId}::mock_usdc::mint`,
							arguments: [tx.object(usdcCap), tx.pure.u64(amount), tx.pure.address(addr)],
						});
					}
					for (const { recipient, amount } of WETH_DISTRIBUTION) {
						const addr = ctx.registry.accounts.require(recipient).address;
						tx.moveCall({
							target: `${weth.packageId}::mock_weth::mint`,
							arguments: [tx.object(wethCap), tx.pure.u64(amount), tx.pure.address(addr)],
						});
					}
					const result = await client.signAndExecuteTransaction({
						signer: publisher,
						transaction: tx,
						options: { showEffects: true },
					});
					if (result.effects?.status.status !== 'success') {
						throw new Error(
							`wallet.seedTokens: tx failed: ${result.effects?.status.error ?? 'unknown'}`,
						);
					}
					await client.waitForTransaction({ digest: result.digest });
				},
			}),
			seed({
				name: 'seedPools',
				// `seedTokens` is a soft dependency: the reconciler runs
				// independent actions in parallel (default concurrency 4) and
				// both seeds sign with the publisher account, so without this
				// edge they race on the publisher's gas object and one of them
				// fails with "already locked by a different transaction".
				needs: ['imports.deepbook', 'usdc', 'weth', 'seedTokens'],
				inputs: { pools: POOLS.map((p) => p.name) },
				getStatus: async (ctx) => {
					const deepbook = ctx.registry.packages.find('deepbook');
					if (deepbook === undefined) return { ok: false, detail: 'deepbook missing' };
					const ns = ctx.registry.ns<WalletNamespace>('wallet');
					const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
					for (const spec of POOLS) {
						const cached = ns.pools.find(spec.name);
						if (cached === undefined) return { ok: false, detail: `pool ${spec.name} missing` };
						const expected = expectedPoolType(deepbook.packageId, ctx.registry, spec);
						if (cached.objectType !== expected) {
							return { ok: false, detail: `pool ${spec.name} type stale` };
						}
						const live = await client.getObject({ id: cached.poolId });
						if (live.data === null || live.data === undefined) {
							return { ok: false, detail: `pool ${cached.poolId} not on chain` };
						}
					}
					return { ok: true, detail: `${POOLS.length} pools live` };
				},
				run: async (ctx) => {
					const publisher = ctx.accounts.get('publisher');
					const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
					const deepbook = ctx.registry.packages.require('deepbook');
					const registryId = deepbook.captured.registryId;
					const adminCapId = deepbook.captured.adminCapId;
					if (registryId === undefined || adminCapId === undefined) {
						throw new Error('wallet.seedPools: deepbook captures missing');
					}

					const tx = new Transaction();
					tx.setGasBudget(500_000_000);
					tx.moveCall({
						target: `${deepbook.packageId}::registry::init_balance_manager_map`,
						arguments: [tx.object(registryId), tx.object(adminCapId)],
					});
					for (const spec of POOLS) {
						const baseType = coinTypeFor(ctx.registry, spec.baseCoinKey);
						const quoteType = coinTypeFor(ctx.registry, spec.quoteCoinKey);
						tx.moveCall({
							target: `${deepbook.packageId}::pool::create_pool_admin`,
							typeArguments: [baseType, quoteType],
							arguments: [
								tx.object(registryId),
								tx.pure.u64(spec.tickSize),
								tx.pure.u64(spec.lotSize),
								tx.pure.u64(spec.minSize),
								tx.pure.bool(true), // whitelisted_pool — disables DEEP fee
								tx.pure.bool(false), // stable_pool
								tx.object(adminCapId),
							],
						});
					}
					const result = await client.signAndExecuteTransaction({
						signer: publisher,
						transaction: tx,
						options: { showEffects: true, showObjectChanges: true },
					});
					if (result.effects?.status.status !== 'success') {
						throw new Error(
							`wallet.seedPools: tx failed: ${result.effects?.status.error ?? 'unknown'}`,
						);
					}
					await client.waitForTransaction({ digest: result.digest });

					const ns = ctx.registry.ns<WalletNamespace>('wallet');
					for (const spec of POOLS) {
						const baseType = coinTypeFor(ctx.registry, spec.baseCoinKey);
						const quoteType = coinTypeFor(ctx.registry, spec.quoteCoinKey);
						const expected = `${deepbook.packageId}::pool::Pool<${baseType}, ${quoteType}>`;
						const found = (result.objectChanges ?? []).find(
							(c) => c.type === 'created' && 'objectType' in c && c.objectType === expected,
						);
						if (found === undefined || found.type !== 'created') {
							throw new Error(`wallet.seedPools: created Pool object missing for ${spec.name}`);
						}
						ns.pools.register({
							name: spec.name,
							poolId: found.objectId,
							objectType: expected,
							baseCoinType: baseType,
							quoteCoinType: quoteType,
						});
					}
				},
			}),
			seed({
				name: 'seedOrders',
				needs: ['seedPools', 'seedTokens'],
				inputs: {
					pools: POOLS.map((p) => p.name),
					perSide: 3, // 3 asks + 3 bids per pool
				},
				getStatus: async (ctx) => {
					const ns = ctx.registry.ns<WalletNamespace>('wallet');
					const cached = ns.balanceManager.find('alice');
					if (cached === undefined) return { ok: false, detail: 'no cached BM' };
					const aliceAddr = ctx.registry.accounts.find('alice')?.address;
					if (aliceAddr !== cached.owner) {
						return { ok: false, detail: 'cached BM owner != alice' };
					}
					const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
					const live = await client.getObject({ id: cached.objectId });
					if (live.data === null || live.data === undefined) {
						return { ok: false, detail: `BM ${cached.objectId} not on chain` };
					}
					return { ok: true, detail: cached.objectId };
				},
				run: async (ctx) => {
					await placeSeedOrders(ctx);
				},
			}),
		],
	});

function coinTypeFor(registry: Registry, key: 'sui' | 'mock_usdc' | 'mock_weth'): string {
	if (key === 'sui') return SUI_COIN_TYPE;
	const pkg = registry.packages.require(key);
	return `${pkg.packageId}::${key}::${key.toUpperCase()}`;
}

function expectedPoolType(deepbookPkg: string, registry: Registry, spec: PoolSpec): string {
	const base = coinTypeFor(registry, spec.baseCoinKey);
	const quote = coinTypeFor(registry, spec.quoteCoinKey);
	return `${deepbookPkg}::pool::Pool<${base}, ${quote}>`;
}

async function placeSeedOrders(
	ctx: import('@mysten-incubation/devstack').ActionRunContext,
): Promise<void> {
	const alice = ctx.accounts.get('alice');
	const aliceAddr = alice.toSuiAddress();
	const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
	const deepbook = ctx.registry.packages.require('deepbook');

	const ns = ctx.registry.ns<WalletNamespace>('wallet');
	const poolEntries = POOLS.map((spec) => {
		const cached = ns.pools.require(spec.name);
		return { spec, cached };
	});

	const usdcType = coinTypeFor(ctx.registry, 'mock_usdc');
	const wethType = coinTypeFor(ctx.registry, 'mock_weth');

	const tx = new Transaction();
	tx.setGasBudget(1_000_000_000);

	const bm = tx.moveCall({
		target: `${deepbook.packageId}::balance_manager::new`,
		arguments: [],
	});

	// 100 SUI per pool (base) — total split from gas.
	const depositSui = 100_000_000_000n;
	const totalSui = depositSui * BigInt(POOLS.length);
	const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(totalSui)]);
	if (suiCoin === undefined) throw new Error('seedOrders: splitCoins(gas) returned no result');
	tx.moveCall({
		target: `${deepbook.packageId}::balance_manager::deposit`,
		typeArguments: [SUI_COIN_TYPE],
		arguments: [bm, suiCoin],
	});

	// Non-SUI deposits: alice's existing coins, merged + split to deposit amount.
	for (const [coinType, amount] of [
		[usdcType, 1_000_000_000n] as const, // 1,000 mUSDC
		[wethType, 100_000_000n] as const, // 1 mWETH
	]) {
		const { objects } = await client.core.listCoins({ owner: aliceAddr, coinType });
		const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
		if (total < amount) {
			throw new Error(`seedOrders: alice has ${total} of ${coinType}, needs ${amount}`);
		}
		const [primary, ...rest] = objects;
		if (primary === undefined) throw new Error(`seedOrders: no ${coinType} coins`);
		const primaryRef = tx.object(primary.objectId);
		if (rest.length > 0) {
			tx.mergeCoins(
				primaryRef,
				rest.map((c) => tx.object(c.objectId)),
			);
		}
		const [split] = tx.splitCoins(primaryRef, [tx.pure.u64(amount)]);
		if (split === undefined) throw new Error('seedOrders: splitCoins returned no result');
		tx.moveCall({
			target: `${deepbook.packageId}::balance_manager::deposit`,
			typeArguments: [coinType],
			arguments: [bm, split],
		});
	}

	const proof = tx.moveCall({
		target: `${deepbook.packageId}::balance_manager::generate_proof_as_owner`,
		arguments: [bm],
	});

	const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
	let clientOrderId = 1;
	for (const { spec, cached } of poolEntries) {
		// Mid prices are arbitrary stand-ins; step = tickSize. Sized so 6 orders
		// (3 asks + 3 bids) fit per pool.
		const mid = spec.name === 'sui_usdc' ? 3_500_000n : 10_000n;
		for (let i = 1; i <= 3; i++) {
			for (const isBid of [false, true] as const) {
				const offset = spec.tickSize * BigInt(i);
				const price = isBid ? mid - offset : mid + offset;
				tx.moveCall({
					target: `${deepbook.packageId}::pool::place_limit_order`,
					typeArguments: [cached.baseCoinType, cached.quoteCoinType],
					arguments: [
						tx.object(cached.poolId),
						bm,
						proof,
						tx.pure.u64(BigInt(clientOrderId++)),
						tx.pure.u8(ORDER_TYPE_NO_RESTRICTION),
						tx.pure.u8(SELF_MATCHING_ALLOWED),
						tx.pure.u64(price),
						tx.pure.u64(spec.minSize),
						tx.pure.bool(isBid),
						tx.pure.bool(false), // pay_with_deep — whitelisted pool waives
						tx.pure.u64(expireMs),
						tx.object(SUI_CLOCK_OBJECT_ID),
					],
				});
			}
		}
	}

	tx.transferObjects([bm], aliceAddr);

	const result = await client.signAndExecuteTransaction({
		signer: alice,
		transaction: tx,
		options: { showEffects: true, showObjectChanges: true },
	});
	if (result.effects?.status.status !== 'success') {
		throw new Error(`wallet.seedOrders: tx failed: ${result.effects?.status.error ?? 'unknown'}`);
	}
	await client.waitForTransaction({ digest: result.digest });

	// Locate the transferred BalanceManager in objectChanges so getStatus can
	// short-circuit on the next cycle.
	const bmType = `${deepbook.packageId}::balance_manager::BalanceManager`;
	const bmObj = (result.objectChanges ?? []).find(
		(c) => c.type === 'created' && 'objectType' in c && c.objectType === bmType,
	);
	if (bmObj === undefined || bmObj.type !== 'created') {
		throw new Error('wallet.seedOrders: BalanceManager object missing from changes');
	}
	ns.balanceManager.register({
		name: 'alice',
		objectId: bmObj.objectId,
		owner: aliceAddr,
	});
}
