// Wallet app — multi-coin wallet UI + DeepBook v3 swap. Two mock coins
// (mUSDC + mWETH) are published as the publisher and seeded into
// alice/bob/carol via a single batched tx. The publisher's TreasuryCap
// surfaces through `Package`'s `capture` field so the dev-wallet faucet
// panel can mint test funds on demand. DeepBook v3 is published from
// the vendored `.devstack/imports/...` source; pools reference the
// mock-coin refs (resolved after publish) and alice runs a continuous
// in-process maker so swap cards see real on-chain liquidity.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import {
	Account,
	Action,
	Codegen,
	Deepbook,
	DeepbookMarketMaker,
	Dev,
	devstack,
	Package,
	registerCoin,
	Wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');
const DEEPBOOK_DIR = resolve(
	HERE,
	'.devstack/imports/mystenlabs_deepbookv3@v7.0.0/packages/deepbook',
);

const USDC_DISTRIBUTION = [
	{ recipient: 'alice', amount: 75_000_000_000n },
	{ recipient: 'bob', amount: 10_000_000_000n },
	{ recipient: 'carol', amount: 5_000_000_000n },
] as const;
const WETH_DISTRIBUTION = [
	{ recipient: 'alice', amount: 6_000_000_000n },
	{ recipient: 'bob', amount: 500_000_000n },
	{ recipient: 'carol', amount: 200_000_000n },
] as const;

const publisher = Account('publisher');
const alice = Account('alice');
const bob = Account('bob');
const carol = Account('carol');

// `capture:` keyed form maps result-key → type-substring. Each entry
// picks the first created object whose type contains the substring and
// surfaces it on the resolved Package as `pkg.captured.<key>`. The
// faucet panel reads `captured.treasuryCapId` to mint test funds.
const COIN_CAPTURE = {
	treasuryCapId: '::coin::TreasuryCap<',
	metadataId: '::coin::CoinMetadata<',
	upgradeCapId: '0x2::package::UpgradeCap',
} as const;

const usdc = Package('mock_usdc', USDC_DIR, {
	signer: publisher,
	capture: COIN_CAPTURE,
	coins: [{ name: 'musdc', module: 'mock_usdc', type: 'MOCK_USDC', decimals: 6 }],
});

const weth = Package('mock_weth', WETH_DIR, {
	signer: publisher,
	capture: COIN_CAPTURE,
	coins: [{ name: 'mweth', module: 'mock_weth', type: 'MOCK_WETH', decimals: 8 }],
});

// Coin refs surface the runtime Move type so deepbook pools can
// reference locally-published coins without static knowledge of the
// post-publish package id. `registerCoin` re-registers the coin in the
// CoinRegistry and returns a Coin ref usable as `quote:` on pool specs.
const musdc = registerCoin({
	name: 'musdc',
	package: usdc,
	module: 'mock_usdc',
	type: 'MOCK_USDC',
	decimals: 6,
});

const mweth = registerCoin({
	name: 'mweth',
	package: weth,
	module: 'mock_weth',
	type: 'MOCK_WETH',
	decimals: 8,
});

const seedTokens = Action('wallet.seedTokens', {
	signer: publisher,
	gasBudget: 500_000_000n,
	needs: [usdc, weth],
	build: (t) =>
		Effect.gen(function* () {
			const usdcPkg = yield* usdc;
			const wethPkg = yield* weth;
			const a = yield* alice;
			const b = yield* bob;
			const c = yield* carol;
			const addrFor: Record<'alice' | 'bob' | 'carol', string> = {
				alice: a.address,
				bob: b.address,
				carol: c.address,
			};
			for (const spec of [
				{ pkg: usdcPkg, module: 'mock_usdc', distribution: USDC_DISTRIBUTION },
				{ pkg: wethPkg, module: 'mock_weth', distribution: WETH_DISTRIBUTION },
			]) {
				const treasuryCapId = (spec.pkg.captured as Record<string, string> | undefined)
					?.treasuryCapId;
				if (treasuryCapId === undefined) {
					yield* Effect.die(
						`seedTokens: package '${spec.pkg.name}' missing captured.treasuryCapId`,
					) as Effect.Effect<void, never, never>;
					return;
				}
				const target = `${spec.pkg.packageId}::${spec.module}::mint`;
				for (const entry of spec.distribution) {
					t.moveCall({
						target,
						arguments: [
							t.object(treasuryCapId),
							t.pure.u64(entry.amount),
							t.pure.address(addrFor[entry.recipient]),
						],
					});
				}
			}
		}),
});

const deepbook = Deepbook({
	local: {
		signer: publisher,
		movePackagePath: DEEPBOOK_DIR,
		pools: [
			{
				name: 'sui_usdc',
				base: '0x2::sui::SUI',
				quote: musdc,
				tickSize: 1_000n,
				lotSize: 100_000_000n,
				minSize: 1_000_000_000n,
			},
			{
				name: 'sui_weth',
				base: '0x2::sui::SUI',
				quote: mweth,
				tickSize: 100n,
				lotSize: 100_000_000n,
				minSize: 1_000_000_000n,
			},
		],
	},
});

// alice market-makes both pools. Depends on `seedTokens` so alice has
// the mock-coin inventory available when the maker's first tick
// deposits into the BalanceManager, and on `deepbook` so the on-chain
// pools exist before the maker's findPool lookups run.
const maker = DeepbookMarketMaker({
	name: 'deepbook.maker',
	signer: alice,
	pools: [
		{
			name: 'sui_usdc',
			base: '0x2::sui::SUI',
			quote: musdc,
			tickSize: 1_000n,
			midPrice: 3_500_000n,
			sizePerLevel: 1_000_000_000n,
		},
		{
			name: 'sui_weth',
			base: '0x2::sui::SUI',
			quote: mweth,
			tickSize: 100n,
			midPrice: 10_000n,
			sizePerLevel: 1_000_000_000n,
		},
	],
	dependsOn: [seedTokens, deepbook],
});

const wallet = Wallet({
	accounts: [publisher, alice, bob, carol],
	allowedOrigins: ['http://dev.wallet.localhost:5175', 'http://localhost:5174'],
});

const codegen = Codegen({ packages: [usdc, weth] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5174,
	needs: [usdc, weth, seedTokens, deepbook, wallet, codegen],
});

export default devstack(
	publisher,
	alice,
	bob,
	carol,
	usdc,
	weth,
	musdc,
	mweth,
	seedTokens,
	deepbook,
	maker,
	wallet,
	codegen,
	dev,
	{
		// Project the deepbook pools into a UI-friendly extras blob so
		// the swap card can fetch live liquidity without re-resolving
		// pool ids from on-chain state.
		extras: Effect.gen(function* () {
			// `Deepbook` is a discriminated union (known | local). This config
			// always uses the local branch, which carries a `pools` record off
			// the pool generics. Cast to the local-branch shape so per-pool
			// projection compiles without re-deriving the generics.
			type Pool = { name: string; poolId: string; base: string; quote: string };
			const live = (yield* deepbook) as { readonly pools: Record<string, Pool> };
			const pools = Object.values(live.pools).map((p) => ({
				name: p.name,
				poolId: p.poolId,
				baseCoinType: p.base,
				quoteCoinType: p.quote,
			}));
			return { deepbookPools: { pools } };
		}),
	},
);
