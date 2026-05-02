// Wallet app — multi-coin wallet UI + DeepBook v3 swap. DeepBook itself
// is published + pools created + continuously made-by alice via the
// `deepbook()` plugin; the app-level `setup:` handles the mock coin
// publishes and the supply mint.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	codegen,
	deepbook,
	defineDevstackConfig,
	frontend,
	publishMove,
	seed,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient } from '@mysten-incubation/devstack/helpers';
import { Transaction } from '@mysten/sui/transactions';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');

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
			// Continuous liquidity: alice runs a single grid maker across
			// both pools, refreshing every 10 s. HostProcess type means the
			// supervisor (`pnpm dev`, `devstack up`/`watch`) owns the loop;
			// it's skipped by Playwright globalSetup so test setup brings
			// the chain to known state but doesn't start a daemon.
			marketMakers: [
				{
					name: 'alice',
					signer: 'alice',
					pools: ['sui_usdc', 'sui_weth'],
					// alice needs to own mUSDC + mWETH before the maker can
					// deposit them into her BM. seedTokens mints those coins.
					needs: ['wallet-setup.seedTokens'],
					midPrices: {
						sui_usdc: 3_500_000n, // 3.5 mUSDC per SUI (6-dec quote)
						sui_weth: 10_000n, // 0.0001 mWETH per SUI (8-dec quote)
					},
					sizePerLevel: 1_000_000_000n, // 1 SUI per order
					levels: 3,
					tickSpacing: 1,
				},
			],
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
			needs: ['sui.accounts'],
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
		// carol per the configured distribution.
		seed({
			name: 'seedTokens',
			needs: ['usdc', 'weth'],
			runsAs: 'publisher',
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
	],
});
