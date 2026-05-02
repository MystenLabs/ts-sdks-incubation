// Wallet app — multi-coin wallet UI + DeepBook v3 swap. DeepBook itself
// is published + pools created by the `deepbook()` plugin; the
// app-level `setup:` handles the mock coin publishes, the supply mint,
// and a static order seeding (PR 14 will replace the static seed with
// a deepbook market-maker for continuous liquidity).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type Registry,
	type RegistryQuery,
	codegen,
	deepbook,
	deepbookNs,
	defineDevstackConfig,
	frontend,
	publishMove,
	resolveCoinType,
	seed,
	SUI_COIN_TYPE,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient } from '@mysten-incubation/devstack/helpers';
import { Transaction } from '@mysten/sui/transactions';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');

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

// Pool specs flow into the deepbook() plugin's `pools:` field. The
// `@reg/<name>` references resolve at run time via
// `registry.tokens.find(name).type` — the publishMove `onPublished`
// hooks below register `musdc` and `mweth` before deepbook.pools runs
// (see `poolNeeds:` on the deepbook plugin).
const POOL_SPECS = [
	{
		name: 'sui_usdc',
		base: 'sui',
		quote: '@reg/musdc',
		tickSize: 1_000n, // 0.001 mUSDC per SUI (quote, 6 dec)
		lotSize: 100_000_000n, // 0.1 SUI step (base, 9 dec)
		minSize: 1_000_000_000n, // 1 SUI minimum (base, 9 dec)
	},
	{
		name: 'sui_weth',
		base: 'sui',
		quote: '@reg/mweth',
		tickSize: 100n, // 0.000001 mWETH per SUI (quote, 8 dec)
		lotSize: 100_000_000n, // 0.1 SUI step (base, 9 dec)
		minSize: 1_000_000_000n, // 1 SUI minimum (base, 9 dec)
	},
] as const;

interface WalletBalanceManager {
	name: string;
	objectId: string;
	owner: string;
}

interface WalletNamespace {
	balanceManager: RegistryQuery<WalletBalanceManager>;
}

export default defineDevstackConfig({
	app: 'wallet',
	accounts: {
		publisher: {},
		alice: {},
		bob: {},
		carol: {},
	},
	plugins: [
		sui({ version: 'devnet-v1.71.0', rpcPort: 9376, faucetPort: 9765 }),
		deepbook({
			rev: 'v7.0.0',
			pools: POOL_SPECS,
			// Pool creation depends on the mock-coin publishes below registering
			// `musdc` / `mweth` tokens before deepbook.pools' run resolves the
			// `@reg/<name>` references.
			poolNeeds: ['wallet-setup.usdc', 'wallet-setup.weth'],
		}),
		codegen(),
		walletServer({ port: 9420 }),
		frontend({ port: 5174 }),
	],
	setup: [
		publishMove({
			name: 'usdc',
			needs: ['sui.accounts'],
			registryAs: 'mock_usdc',
			path: USDC_DIR,
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
		publishMove({
			name: 'weth',
			// Serialized after `usdc` so both publishes don't equivocate on the
			// publisher's gas object. See notes/friction.md — same-signer
			// transactions should serialize automatically at the reconciler.
			needs: ['usdc'],
			registryAs: 'mock_weth',
			path: WETH_DIR,
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
		// publisher mints the initial USDC + WETH supply to alice/bob/
		// carol per the configured distribution. Also depends on
		// `deepbook.pools` so it doesn't equivocate on publisher's gas
		// object — same-signer serialization (see notes/friction.md).
		seed({
			name: 'seedTokens',
			needs: ['usdc', 'weth', 'deepbook.pools'],
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
					throw new Error('seedTokens: TreasuryCap ids missing from manifest');
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
					throw new Error(`seedTokens: tx failed: ${result.effects?.status.error ?? 'unknown'}`);
				}
				await client.waitForTransaction({ digest: result.digest });
			},
		}),
		// alice creates a fresh BalanceManager, deposits SUI/mUSDC/mWETH,
		// and posts 6 limit orders per pool so swaps in the UI have
		// something to take. PR 14 replaces this with a deepbook
		// market-maker action for continuous liquidity.
		seed({
			name: 'seedOrders',
			needs: ['deepbook.pools', 'seedTokens'],
			inputs: {
				pools: POOL_SPECS.map((p) => p.name),
				perSide: 3,
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
				const alice = ctx.accounts.get('alice');
				const aliceAddr = alice.toSuiAddress();
				const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
				const deepbookPkg = ctx.registry.packages.require('deepbook');

				const dbNs = deepbookNs(ctx.registry);
				const poolEntries = POOL_SPECS.map((spec) => ({
					spec,
					cached: dbNs.pools.require(spec.name),
				}));

				const usdcType = resolveCoinType(ctx.registry, '@reg/musdc');
				const wethType = resolveCoinType(ctx.registry, '@reg/mweth');

				const tx = new Transaction();
				tx.setGasBudget(1_000_000_000);

				const bm = tx.moveCall({
					target: `${deepbookPkg.packageId}::balance_manager::new`,
					arguments: [],
				});

				// 100 SUI per pool (base) — total split from gas.
				const depositSui = 100_000_000_000n;
				const totalSui = depositSui * BigInt(POOL_SPECS.length);
				const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(totalSui)]);
				if (suiCoin === undefined)
					throw new Error('seedOrders: splitCoins(gas) returned no result');
				tx.moveCall({
					target: `${deepbookPkg.packageId}::balance_manager::deposit`,
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
						target: `${deepbookPkg.packageId}::balance_manager::deposit`,
						typeArguments: [coinType],
						arguments: [bm, split],
					});
				}

				const proof = tx.moveCall({
					target: `${deepbookPkg.packageId}::balance_manager::generate_proof_as_owner`,
					arguments: [bm],
				});

				const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
				let clientOrderId = 1;
				for (const { spec, cached } of poolEntries) {
					// Mid prices are arbitrary stand-ins; step = tickSize.
					const mid = spec.name === 'sui_usdc' ? 3_500_000n : 10_000n;
					for (let i = 1; i <= 3; i++) {
						for (const isBid of [false, true] as const) {
							const offset = spec.tickSize * BigInt(i);
							const price = isBid ? mid - offset : mid + offset;
							tx.moveCall({
								target: `${deepbookPkg.packageId}::pool::place_limit_order`,
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
					throw new Error(`seedOrders: tx failed: ${result.effects?.status.error ?? 'unknown'}`);
				}
				await client.waitForTransaction({ digest: result.digest });

				// Locate the transferred BalanceManager so getStatus can short-circuit.
				const bmType = `${deepbookPkg.packageId}::balance_manager::BalanceManager`;
				const bmObj = (result.objectChanges ?? []).find(
					(c) => c.type === 'created' && 'objectType' in c && c.objectType === bmType,
				);
				if (bmObj === undefined || bmObj.type !== 'created') {
					throw new Error('seedOrders: BalanceManager object missing from changes');
				}
				ctx.registry.ns<WalletNamespace>('wallet').balanceManager.register({
					name: 'alice',
					objectId: bmObj.objectId,
					owner: aliceAddr,
				});
			},
		}),
	],
});
