import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	coin,
	dashboard,
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
// DeepBook's Move packages are pulled straight from their upstream repos —
// no vendored tree to maintain. The clone is cached host-side per (url, rev).
// Each rev is pinned to a concrete SHA (the commit each repo's `main` currently
// points at) so the generated bindings stay reproducible and CI doesn't flake on
// an upstream move. To bump: `git ls-remote <repo> refs/heads/main` and paste the
// resulting SHA below (then re-run `devstack codegen` to refresh bindings).
const DEEPBOOKV3_REPO = 'https://github.com/MystenLabs/deepbookv3.git';
const SANDBOX_REPO = 'https://github.com/MystenLabs/deepbook-sandbox.git';
// Pinned to MystenLabs/deepbookv3@main as of 2026-06-17.
const DEEPBOOKV3_REV = '5411ef3aa93f7722409b2a85047baa3d4d830c07';
// Pinned to MystenLabs/deepbook-sandbox@main as of 2026-06-17.
const SANDBOX_REV = 'e62fa7df04b444a2ad72362802fd2ad3e8e61408';

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
	git: { url: DEEPBOOKV3_REPO, subdir: 'packages/dusdc', rev: DEEPBOOKV3_REV },
	publisher: usdcPublisher,
});
const usdc = coin.fromPackage(usdcPackage, 'DUSDC');
// Demo coins are app-authored, so they stay a local Move package.
const demoCoinsPackage = localPackage('demo_coins', {
	sourcePath: resolve(HERE, 'move/demo_coins'),
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
	git: { url: DEEPBOOKV3_REPO, subdir: 'packages/deepbook', rev: DEEPBOOKV3_REV },
	publisher,
	capture: {
		registryId: '::registry::Registry',
		adminCapId: '::registry::DeepbookAdminCap',
		deepTreasuryId: '::deep::ProtectedTreasury',
	},
});
const pythPackage = localPackage('pyth', {
	git: { url: SANDBOX_REPO, subdir: 'sandbox/packages/pyth', rev: SANDBOX_REV },
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
	members: [localnet, app, dashboard()],
	stackName: 'deepbook-trader',
});

export default stack;
