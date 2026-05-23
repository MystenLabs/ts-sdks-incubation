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
	pythPriceFeedId,
	SUI_PRICE_FEED_ID,
	sui,
	type Stack,
	USDC_PRICE_FEED_ID,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5182;
const TRADER_USDC_STAKE = 5_000_000_000n;
const TRADER_DBTC_STAKE = 100_000_000n;
const TRADER_DETH_STAKE = 10_000_000_000n;
const DBTC_PRICE_FEED_ID = pythPriceFeedId(
	'c8e0d8e7f2a5b6c7d8e9f00112233445566778899aabbccddeeff00112233440',
);
const DETH_PRICE_FEED_ID = pythPriceFeedId(
	'd1e2f3a40516273849a5b6c7d8e9f00112233445566778899aabbccddeeff000',
);
const VENDORED_DEEPBOOK_SOURCE_ROOT = resolve(HERE, 'move/vendor/deepbookv3');
const VENDORED_SANDBOX_SOURCE_ROOT = resolve(HERE, 'move/vendor/deepbook-sandbox');

const DEEP_SUI_POOL = {
	name: 'DEEP_SUI',
	tickSize: 1_000_000n,
	lotSize: 1_000_000n,
	minSize: 10_000_000n,
	seedPrice: 6_000_000n,
	seedBidPrice: 5_000_000n,
	seedBaseAmount: 1_000_000_000n,
	seedQuoteAmount: 10_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

const SUI_USDC_POOL = {
	name: 'SUI_USDC',
	tickSize: 1_000n,
	lotSize: 100_000_000n,
	minSize: 1_000_000_000n,
	seedPrice: 3_500_000n,
	seedBidPrice: 3_499_000n,
	seedBaseAmount: 100_000_000_000n,
	seedQuoteAmount: 1_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

const DBTC_USDC_POOL = {
	name: 'DBTC_USDC',
	tickSize: 1_000_000n,
	lotSize: 10_000n,
	minSize: 10_000n,
	seedPrice: 65_000_000_000n,
	seedBidPrice: 64_999_000_000n,
	seedBaseAmount: 200_000_000n,
	seedQuoteAmount: 200_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

const DETH_USDC_POOL = {
	name: 'DETH_USDC',
	tickSize: 100_000n,
	lotSize: 100_000n,
	minSize: 100_000n,
	seedPrice: 3_200_000_000n,
	seedBidPrice: 3_199_900_000n,
	seedBaseAmount: 1_000_000_000n,
	seedQuoteAmount: 50_000_000_000n,
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
	demoCoins: requirePackage(resolve(HERE, 'move/demo_coins'), 'demo coins'),
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
const usdcPublisher = account('usdcPublisher', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
});
const demoCoinPublisher = account('demoCoinPublisher', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
});
const pythPublisher = account('pythPublisher', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
});
const suiCoin = coin.builtin('sui');
const usdcPackage = localPackage('dusdc', {
	sourcePath: deepbookSources.dusdc,
	publisher: usdcPublisher,
});
const usdc = coin.fromPackage(usdcPackage, 'DUSDC');
const demoCoinsPackage = localPackage('demo_coins', {
	sourcePath: deepbookSources.demoCoins,
	publisher: demoCoinPublisher,
});
const dbtc = coin.fromPackage(demoCoinsPackage, 'DBTC');
const deth = coin.fromPackage(demoCoinsPackage, 'DETH');
const trader = account('trader', {
	kind: 'ephemeral',
	funding: [
		{ coin: 'sui', amount: 1_000_000_000_000n },
		{ coin: usdc, amount: TRADER_USDC_STAKE },
		{ coin: dbtc, amount: TRADER_DBTC_STAKE },
		{ coin: deth, amount: TRADER_DETH_STAKE },
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
	publisher: pythPublisher,
});
const deep = coin.fromPackage(deepbookPackage, 'DEEP');
const dex = deepbook({
	mode: 'local',
	publisher,
	package: deepbookPackage,
	deepTreasuryIdKey: 'deepTreasuryId',
	pyth: {
		package: pythPackage,
		pusher: pythPublisher,
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
			{
				symbol: 'DBTC',
				feedId: DBTC_PRICE_FEED_ID,
				initialPrice: 6_500_000_000_000n,
				expo: -8,
			},
			{
				symbol: 'DETH',
				feedId: DETH_PRICE_FEED_ID,
				initialPrice: 320_000_000_000n,
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
				quoteAmount: DEEP_SUI_POOL.seedQuoteAmount,
				orders: [
					{
						side: 'ask',
						price: DEEP_SUI_POOL.seedPrice,
						quantity: DEEP_SUI_POOL.seedBaseAmount,
					},
					{
						side: 'bid',
						price: DEEP_SUI_POOL.seedBidPrice,
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
				quoteAmount: SUI_USDC_POOL.seedQuoteAmount,
				orders: [
					{
						side: 'ask',
						price: SUI_USDC_POOL.seedPrice,
						quantity: SUI_USDC_POOL.seedBaseAmount,
					},
					{
						side: 'bid',
						price: SUI_USDC_POOL.seedBidPrice,
						quantity: SUI_USDC_POOL.seedBaseAmount,
					},
				],
			},
		},
		{
			...DBTC_USDC_POOL,
			base: { key: 'DBTC', coin: dbtc },
			quote: { key: 'USDC', coin: usdc },
			seed: {
				baseAmount: DBTC_USDC_POOL.seedBaseAmount,
				quoteAmount: DBTC_USDC_POOL.seedQuoteAmount,
				orders: [
					{
						side: 'ask',
						price: DBTC_USDC_POOL.seedPrice,
						quantity: DBTC_USDC_POOL.seedBaseAmount,
					},
					{
						side: 'bid',
						price: DBTC_USDC_POOL.seedBidPrice,
						quantity: DBTC_USDC_POOL.seedBaseAmount,
					},
				],
			},
		},
		{
			...DETH_USDC_POOL,
			base: { key: 'DETH', coin: deth },
			quote: { key: 'USDC', coin: usdc },
			seed: {
				baseAmount: DETH_USDC_POOL.seedBaseAmount,
				quoteAmount: DETH_USDC_POOL.seedQuoteAmount,
				orders: [
					{
						side: 'ask',
						price: DETH_USDC_POOL.seedPrice,
						quantity: DETH_USDC_POOL.seedBaseAmount,
					},
					{
						side: 'bid',
						price: DETH_USDC_POOL.seedBidPrice,
						quantity: DETH_USDC_POOL.seedBaseAmount,
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
