// deepbook-full — reference example exercising the full deepbook stack
// (Phase 5 of the deepbook plugin expansion plan). Composes every primitive
// the plugin offers: vendored Move sources, Postgres backing store, Pyth
// oracle + pusher fiber, deepbook local-deploy with whitelisted pools,
// margin pool + seed, indexer + server containers, and a bps-grid maker
// with per-pool BalanceManagers.

import { Effect } from 'effect';
import {
	Account,
	Codegen,
	Deepbook,
	DeepbookIndexer,
	DeepbookMargin,
	DeepbookMarketMaker,
	DeepbookServer,
	DEFAULT_POOL_RISK_CONFIG,
	Dev,
	devstack,
	Postgres,
	Pyth,
	PythPusher,
	SUI_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
	SUI_MARGIN_DEFAULTS,
	USDC_MARGIN_DEFAULTS,
	VendorDeepbook,
	Wallet,
} from '@mysten-incubation/devstack';

// Per-service signers. Margin (R8): the pyth pusher's signer MUST differ
// from any market-maker's signer to avoid gas-coin contention; the
// publisher's signer covers package publish + admin txs and must differ
// from both for the same reason. `alice` + `bob` reserved for user-facing
// UI flows (trading, mint).
const publisher = Account('publisher');
const pythPusherAccount = Account('pyth-pusher');
const marketMaker = Account('market-maker');
const alice = Account('alice');
const bob = Account('bob');

// Vendor the deepbook + deepbook-sandbox Move sources to
// `.devstack/vendor/deepbook/v7.0.0/`. Six packages materialized:
// `token`, `deepbook`, `pyth`, `usdc`, `deepbook_margin`, `margin_liquidation`.
// `gitFetch` caches the clones under `~/.devstack-cache/git-fetch/<hash>/`
// so subsequent stacks reuse the same vendor tree.
//
// Repo override: the upstream Move source was renamed
// `MystenLabs/deepbook` → `MystenLabs/deepbookv3`; the legacy URL now
// 404s and the plugin's built-in default still points at the old name
// (kept for backward-compat with pinned stacks that have local caches).
// We pin the canonical URL here so a fresh CI checkout resolves.
const vendor = VendorDeepbook({
	ref: 'v7.0.0',
	deepbookRepo: 'https://github.com/MystenLabs/deepbookv3',
});

// Long-lived Postgres container backing the indexer + server. Two
// logical databases: `deepbook` (the indexer's primary write target,
// server reads from it) + `devstack` (default; reserved for future
// per-stack bookkeeping).
const postgres = Postgres({ databases: ['deepbook', 'devstack'] });

// Pyth local-deploy. Publishes the vendored Pyth Move package and
// creates three PriceInfoObjects (SUI, DEEP, USDC). The pusher fiber
// then updates these on a 10s cadence against benchmarks.pyth.network.
//
// Initial prices: historical magnitudes for stability across sessions.
// `expoMagnitude: 8n` + `expoNegative: true` encodes `-8` (Pyth's
// canonical exponent for USD-denominated feeds).
const pyth = Pyth({
	local: {
		signer: publisher,
		vendor,
		feeds: [
			{
				label: 'SUI',
				feedId: SUI_PRICE_FEED_ID,
				initial: {
					feedId: SUI_PRICE_FEED_ID,
					priceMagnitude: 350_000_000n,
					priceNegative: false,
					expoMagnitude: 8n,
					expoNegative: true,
					publishTime: BigInt(Math.floor(Date.now() / 1000)),
				},
			},
			{
				label: 'DEEP',
				feedId: DEEP_PRICE_FEED_ID,
				initial: {
					feedId: DEEP_PRICE_FEED_ID,
					priceMagnitude: 10_000_000n,
					priceNegative: false,
					expoMagnitude: 8n,
					expoNegative: true,
					publishTime: BigInt(Math.floor(Date.now() / 1000)),
				},
			},
			{
				label: 'USDC',
				feedId: USDC_PRICE_FEED_ID,
				initial: {
					feedId: USDC_PRICE_FEED_ID,
					priceMagnitude: 100_000_000n,
					priceNegative: false,
					expoMagnitude: 8n,
					expoNegative: true,
					publishTime: BigInt(Math.floor(Date.now() / 1000)),
				},
			},
		],
	},
});

// Pyth pusher fiber. Dedicated signer (`pythPusherAccount`) to avoid
// gas-coin contention with the publisher + maker. Default source is the
// benchmarks API; for hermetic CI we'd swap to `{kind:'fixture', fetch}`.
//
// The cast is a known artifact: `Pyth()` returns a discriminated-union
// of the local-deploy + known-package factory's output shapes, and TS
// can't narrow the union back to `LayeredTag<any, Pyth, any, any>` at
// the consumer's call site. The runtime contract is identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pusher = PythPusher({
	name: 'pyth-pusher',
	signer: pythPusherAccount,
	pyth: pyth as any,
});

// DeepBook local-deploy: publish the vendored deepbook package and
// create two whitelisted pools. DEEP/SUI is the canonical reference
// pool; SUI/USDC anchors the trading + margin demo.
const deepbook = Deepbook({
	local: {
		signer: publisher,
		vendor,
		pools: [
			{
				name: 'deep_sui',
				base: `${`${deepbookPackagePlaceholder()}::deep::DEEP`}`,
				quote: '0x2::sui::SUI',
				tickSize: 1_000n,
				lotSize: 100_000_000n,
				minSize: 1_000_000_000n,
			},
			{
				name: 'sui_usdc',
				base: '0x2::sui::SUI',
				quote: `${`${usdcCoinTypePlaceholder()}`}`,
				tickSize: 1_000n,
				lotSize: 100_000_000n,
				minSize: 1_000_000_000n,
			},
		],
	},
});

// The two placeholder helpers above let the pool config compile against
// types that resolve at publish time. In practice the deepbook local-deploy
// resolves pool base/quote coin types from tag refs (Coin tags from the
// `Coin(...)` factory family, populated by `Package(...)` auto-discovery).
// The example uses the vendored USDC sub-package; its Coin can be
// addressed via `Coin('USDC')` or `Coin.fromPackage(deepbook, 'USDC')`
// once the deepbook publish resolves.
//
// Layered-tag-driven pool composition is the established pattern for
// post-publish type resolution. For now we use literal type strings
// (the deepbook package id is interpolated by the runtime), and the
// USDC type is taken from the vendored `usdc` sub-package which lives
// at the deepbook parent package id.
function deepbookPackagePlaceholder(): string {
	// `Deepbook` interpolates this lazily — the literal value here
	// doesn't matter; the factory resolves the actual package id at
	// publish time via `(yield* deepbook).packageId`. We keep the string
	// here so the pool spec compiles; the factory rewrites it once the
	// package id is known.
	return '__DEEPBOOK_PACKAGE_ID__';
}

function usdcCoinTypePlaceholder(): string {
	// Same lazy-resolution story — the vendored USDC sub-package's coin
	// type is `<deepbookPackageId>::usdc::USDC` after publish.
	return '__DEEPBOOK_PACKAGE_ID__::usdc::USDC';
}

// Margin primitive. Publishes `deepbook_margin` + `margin_liquidation`,
// creates per-asset MarginPools (USDC + SUI), registers the deepbook
// pool `sui_usdc` for margin trading. Pyth is typecheck-required (D5).
const margin = DeepbookMargin({
	signer: publisher,
	margin: { vendor },
	liquidation: { vendor },
	pyth,
	deepbook,
	assets: [
		{
			...USDC_MARGIN_DEFAULTS,
			coinType: `__DEEPBOOK_PACKAGE_ID__::usdc::USDC`,
		},
		{
			...SUI_MARGIN_DEFAULTS,
			coinType: '0x2::sui::SUI',
		},
	],
	pools: [{ pool: 'sui_usdc', risk: DEFAULT_POOL_RISK_CONFIG }],
});

// Margin seed: mint a SupplierCap + supply per-asset starter liquidity.
// Amounts are in the asset's raw on-chain units (already scaled by the
// asset's coin decimals).
const marginSeed = DeepbookMargin.seed({
	signer: publisher,
	margin,
	amounts: [
		{ label: 'USDC', amount: 10_000_000_000n },
		{ label: 'SUI', amount: 100_000_000_000n },
	],
});

// DeepBook indexer + server containers. Both join Postgres's network +
// the sui localnet's checkpoint volume.
const indexer = DeepbookIndexer({
	postgres,
	sui: undefined as any, // resolved at supervisor build time via default Sui()
	deepbook,
	margin,
	databaseName: 'deepbook',
});

const server = DeepbookServer({
	postgres,
	sui: undefined as any, // resolved at supervisor build time via default Sui()
	deepbook,
	margin,
	databaseName: 'deepbook',
});

// Market maker — bps-grid strategy with per-pool BalanceManagers
// (D4 — per-pool is the only mode). 30 levels per side, 100 bps level
// spacing, 10 bps spread.
const maker = DeepbookMarketMaker({
	name: 'deepbook.maker',
	signer: marketMaker,
	strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 30 },
	pools: [
		{
			name: 'deep_sui',
			base: `__DEEPBOOK_PACKAGE_ID__::deep::DEEP`,
			quote: '0x2::sui::SUI',
			tickSize: 1_000n,
			midPrice: 350_000n,
			sizePerLevel: 100_000_000n,
		},
		{
			name: 'sui_usdc',
			base: '0x2::sui::SUI',
			quote: `__DEEPBOOK_PACKAGE_ID__::usdc::USDC`,
			tickSize: 1_000n,
			midPrice: 3_500_000n,
			sizePerLevel: 1_000_000_000n,
		},
	],
	dependsOn: [deepbook, marginSeed],
});

const wallet = Wallet({
	accounts: [publisher, alice, bob],
	allowedOrigins: ['http://dev.wallet.localhost:5175', 'http://localhost:5179'],
});

// Codegen defaults pick up `BindingsEmitter()`, `StackHandleEmitter()`,
// `DappKitConfigEmitter()`, `DeepbookConfigEmitter()`. The deepbook
// emitter consumes the manifest's services.deepbook + coins + pyth
// state and emits `src/generated/deepbook-config.ts`.
const codegen = Codegen({ packages: [] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5179,
	needs: [deepbook, margin, marginSeed, indexer, server, wallet, codegen],
});

// Silence the unused-variable lint when Effect isn't directly invoked
// from a `gen` block in this config (the pyth-pusher example's fixture
// flow uses Effect only inside its own scope). Re-introduce Effect.gen
// blocks if the config grows extras: or per-action build callbacks.
void Effect;

export default devstack(
	publisher,
	pythPusherAccount,
	marketMaker,
	alice,
	bob,
	vendor,
	postgres,
	pyth,
	pusher,
	deepbook,
	margin,
	marginSeed,
	indexer,
	server,
	maker,
	wallet,
	codegen,
	dev,
);
