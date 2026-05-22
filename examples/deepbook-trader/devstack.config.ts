import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	coin,
	DEEP_PRICE_FEED_ID,
	deepbook,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	SUI_PRICE_FEED_ID,
	sui,
	type Stack,
	USDC_PRICE_FEED_ID,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5182;
const TRADER_USDC_STAKE = 5_000_000_000n;
const VENDORED_DEEPBOOK_SOURCE_ROOT = resolve(HERE, 'move/vendor/deepbookv3');
const VENDORED_SANDBOX_SOURCE_ROOT = resolve(HERE, 'move/vendor/deepbook-sandbox');

const DEEP_SUI_POOL = {
	name: 'DEEP_SUI',
	tickSize: 1_000_000n,
	lotSize: 1_000_000n,
	minSize: 10_000_000n,
	seedPrice: 6_000_000n,
	seedBaseAmount: 1_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

const SUI_USDC_POOL = {
	name: 'SUI_USDC',
	tickSize: 1_000n,
	lotSize: 100_000_000n,
	minSize: 1_000_000_000n,
	seedPrice: 3_500_000n,
	seedBaseAmount: 100_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

function requirePackage(sourcePath: string, packageName: string) {
	if (!existsSync(resolve(sourcePath, 'Move.toml'))) {
		throw new Error(`Missing vendored ${packageName} Move package at ${sourcePath}`);
	}

	return sourcePath;
}

const deepbookSources = {
	token: requirePackage(resolve(VENDORED_DEEPBOOK_SOURCE_ROOT, 'token'), 'DeepBook token'),
	deepbook: requirePackage(resolve(VENDORED_DEEPBOOK_SOURCE_ROOT, 'deepbook'), 'DeepBook'),
	dusdc: requirePackage(resolve(VENDORED_DEEPBOOK_SOURCE_ROOT, 'dusdc'), 'DUSDC'),
	pyth: requirePackage(resolve(VENDORED_SANDBOX_SOURCE_ROOT, 'pyth'), 'Pyth'),
};

const localnet = sui();
const publisher = account('publisher', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
});
const suiCoin = coin.builtin('sui');
const usdcPackage = localPackage('dusdc', {
	sourcePath: deepbookSources.dusdc,
	publisher,
});
const usdc = coin.fromPackage(usdcPackage, 'DUSDC');
const trader = account('trader', {
	kind: 'ephemeral',
	funding: [
		{ coin: 'sui', amount: 1_000_000_000_000n },
		{ coin: usdc, amount: TRADER_USDC_STAKE },
	],
});
const deepbookPackage = localPackage('deepbook', {
	sourcePath: deepbookSources.deepbook,
	publisher,
	capture: {
		registryId: '::registry::Registry',
		adminCapId: '::registry::DeepbookAdminCap',
		deepTreasuryId: '::deep::ProtectedTreasury',
	},
});
const pythPackage = localPackage('pyth', {
	sourcePath: deepbookSources.pyth,
	publisher,
});
const deep = coin.fromPackage(deepbookPackage, 'DEEP');
const dex = deepbook({
	mode: 'local',
	publisher,
	package: deepbookPackage,
	deepTreasuryIdKey: 'deepTreasuryId',
	pyth: {
		package: pythPackage,
		pusher: publisher,
		feeds: [
			{
				symbol: 'DEEP',
				feedId: DEEP_PRICE_FEED_ID,
				initialPrice: 2_000_000n,
				expo: -8,
			},
			{
				symbol: 'SUI',
				feedId: SUI_PRICE_FEED_ID,
				initialPrice: 345_000_000n,
				expo: -8,
			},
			{
				symbol: 'USDC',
				feedId: USDC_PRICE_FEED_ID,
				initialPrice: 100_000_000n,
				expo: -8,
			},
		],
	},
	pools: [
		{
			...DEEP_SUI_POOL,
			base: { key: 'DEEP', coin: deep },
			quote: { key: 'SUI', coin: suiCoin },
			seed: {
				baseAmount: DEEP_SUI_POOL.seedBaseAmount,
				orders: [
					{
						side: 'ask',
						price: DEEP_SUI_POOL.seedPrice,
						quantity: DEEP_SUI_POOL.seedBaseAmount,
					},
				],
			},
		},
		{
			...SUI_USDC_POOL,
			base: { key: 'SUI', coin: suiCoin },
			quote: { key: 'USDC', coin: usdc },
			seed: {
				baseAmount: SUI_USDC_POOL.seedBaseAmount,
				orders: [
					{
						side: 'ask',
						price: SUI_USDC_POOL.seedPrice,
						quantity: SUI_USDC_POOL.seedBaseAmount,
					},
				],
			},
		},
	],
});
const devWallet = wallet({
	accounts: [publisher, trader],
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [dex, devWallet] as const,
});

const stack: Stack = defineDevstack({
	members: [localnet, app],
	stackName: 'deepbook-trader',
});

export default stack;
