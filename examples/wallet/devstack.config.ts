// Wallet app — multi-coin wallet UI + DeepBook v3 swap. DeepBook itself
// is published + pools created + continuously made-by alice via the
// `deepbook()` plugin; the app-level `setup:` handles the mock coin
// publishes and the supply mint.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	codegen,
	deepbook,
	defineDevstackConfig,
	frontend,
	mintCoinDistribution,
	publishMove,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');

// Initial token distributions (raw units, accounting for decimals).
// alice gets a healthy share since she's also the deepbook market-
// maker and needs inventory to seed + replenish her grid.
const USDC_DISTRIBUTION: ReadonlyArray<{ recipient: string; amount: bigint }> = [
	{ recipient: 'alice', amount: 75_000_000_000n }, // 75,000 USDC (6 dec)
	{ recipient: 'bob', amount: 10_000_000_000n }, // 10,000 USDC
	{ recipient: 'carol', amount: 5_000_000_000n }, // 5,000 USDC
];
const WETH_DISTRIBUTION: ReadonlyArray<{ recipient: string; amount: bigint }> = [
	{ recipient: 'alice', amount: 6_000_000_000n }, // 60 WETH (8 dec)
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
	accounts: ['publisher', 'alice', 'bob', 'carol'],
	plugins: [
		sui({ version: 'devnet-v1.71.0', rpcPort: 9376, faucetPort: 9765 }),
		accounts(),
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
					// deposit them into the BM. seedTokens mints those coins.
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
			needs: ['accounts.fund'],
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
			needs: ['accounts.fund'],
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
		// carol per the configured distribution. Idempotence comes from
		// the reconciler's input-hash skip — change a recipient or an
		// amount and the action re-runs; otherwise it skips.
		mintCoinDistribution({
			name: 'seedTokens',
			needs: ['usdc', 'weth'],
			distributions: [
				{ package: 'mock_usdc', module: 'mock_usdc', distribution: USDC_DISTRIBUTION },
				{ package: 'mock_weth', module: 'mock_weth', distribution: WETH_DISTRIBUTION },
			],
		}),
	],
});
