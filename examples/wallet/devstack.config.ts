// Wallet app — multi-coin wallet UI + DeepBook v3 swap. Two mock coins
// (mUSDC + mWETH) are published as the publisher and seeded into
// alice/bob/carol via a single batched tx. The publisher's TreasuryCap
// surfaces through `publishMove`'s `capture` callback so the dev-wallet
// faucet panel can mint test funds on demand. DeepBook v3 is published
// from the vendored `.devstack/imports/...` source; pools reference the
// mock-coin tags by ref (resolved after publish) and alice runs a
// continuous in-process maker so swap cards see real on-chain
// liquidity.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import {
	accounts,
	deepbookLocalDeploy,
	deepbookMarketMaker,
	defineDevstack,
	hostProcess,
	manifest,
	pickCreatedByTypeIncludes,
	pickCreatedByTypeSuffix,
	publishMove,
	registerCoin,
	suiLocalnet,
	tx,
	walletApp,
} from '@mysten-incubation/devstack-effect';
import type { SuiObjectChange } from '@mysten-incubation/devstack-effect';

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

const a = accounts({ publisher: {}, alice: {}, bob: {}, carol: {} });

// Capture TreasuryCap + CoinMetadata + UpgradeCap onto each published
// Package. Faucet panel reads `captured.treasuryCapId` to mint.
const captureCoinObjects = (changes: ReadonlyArray<SuiObjectChange>) => {
	const out: Record<string, string> = {};
	const t = pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<');
	if (t !== undefined) out.treasuryCapId = t;
	const md = pickCreatedByTypeIncludes(changes, '::coin::CoinMetadata<');
	if (md !== undefined) out.metadataId = md;
	const up = pickCreatedByTypeSuffix(changes, '0x2::package::UpgradeCap');
	if (up !== undefined) out.upgradeCapId = up;
	return out;
};

const usdcPublish = publishMove({
	name: 'mock_usdc',
	path: USDC_DIR,
	signer: a.publisher,
	capture: captureCoinObjects,
	coins: [{ name: 'musdc', module: 'mock_usdc', type: 'MOCK_USDC', decimals: 6 }],
});

const wethPublish = publishMove({
	name: 'mock_weth',
	path: WETH_DIR,
	signer: a.publisher,
	capture: captureCoinObjects,
	coins: [{ name: 'mweth', module: 'mock_weth', type: 'MOCK_WETH', decimals: 8 }],
});

// Coin tags surface the runtime Move type so deepbook pools can
// reference locally-published coins without static knowledge of the
// post-publish package id. `registerCoin` accepts the richer
// `publishMove` Package shape and re-registers the coin in the
// CoinRegistry (idempotent — last-wins).
const musdcCoin = registerCoin({
	name: 'musdc',
	package: usdcPublish,
	module: 'mock_usdc',
	type: 'MOCK_USDC',
	decimals: 6,
});

const mwethCoin = registerCoin({
	name: 'mweth',
	package: wethPublish,
	module: 'mock_weth',
	type: 'MOCK_WETH',
	decimals: 8,
});

const seedTokens = tx({
	name: 'wallet.seedTokens',
	signer: a.publisher,
	gasBudget: 500_000_000n,
	dependsOn: [usdcPublish, wethPublish],
	build: (t) =>
		Effect.gen(function* () {
			const usdc = yield* usdcPublish;
			const weth = yield* wethPublish;
			const alice = yield* a.alice;
			const bob = yield* a.bob;
			const carol = yield* a.carol;
			const addrFor: Record<'alice' | 'bob' | 'carol', string> = {
				alice: alice.address,
				bob: bob.address,
				carol: carol.address,
			};
			for (const spec of [
				{ pkg: usdc, module: 'mock_usdc', distribution: USDC_DISTRIBUTION },
				{ pkg: weth, module: 'mock_weth', distribution: WETH_DISTRIBUTION },
			]) {
				const treasuryCapId = (spec.pkg.captured as Record<string, string> | undefined)
					?.treasuryCapId;
				if (treasuryCapId === undefined) {
					return yield* Effect.die(
						`seedTokens: package '${spec.pkg.name}' missing captured.treasuryCapId`,
					);
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

const db = deepbookLocalDeploy({
	name: 'deepbook',
	signer: a.publisher,
	movePackagePath: DEEPBOOK_DIR,
	pools: [
		{
			name: 'sui_usdc',
			base: '0x2::sui::SUI',
			quote: musdcCoin,
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
		{
			name: 'sui_weth',
			base: '0x2::sui::SUI',
			quote: mwethCoin,
			tickSize: 100n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
	],
});

// alice market-makes both pools. Depends on `seedTokens` so alice has
// the mock-coin inventory available when the maker's first tick
// deposits into the BalanceManager, and on `db` so the on-chain pools
// exist before the maker's findPool lookups run.
const maker = deepbookMarketMaker({
	name: 'deepbook.maker',
	signer: a.alice,
	pools: [
		{
			name: 'sui_usdc',
			base: '0x2::sui::SUI',
			quote: musdcCoin,
			tickSize: 1_000n,
			midPrice: 3_500_000n,
			sizePerLevel: 1_000_000_000n,
		},
		{
			name: 'sui_weth',
			base: '0x2::sui::SUI',
			quote: mwethCoin,
			tickSize: 100n,
			midPrice: 10_000n,
			sizePerLevel: 1_000_000_000n,
		},
	],
	dependsOn: [seedTokens, db],
});

const wallet = walletApp({
	accounts: [a.publisher, a.alice, a.bob, a.carol],
	// Router-fronted dev URL on the well-known vite entrypoint port
	// (5175) + legacy direct port for back-compat.
	allowedOrigins: ['http://dev.wallet.localhost:5175', 'http://localhost:5174'],
});

// Project the deepbook pools into a UI-friendly extras blob. Reading
// `db` here also pins the manifest write after deepbook acquires, so
// downstream consumers (frontend) see a populated `deepbookPools`.
const m = manifest({
	extras: Effect.gen(function* () {
		const live = yield* db;
		return {
			deepbookPools: {
				pools: Object.values(live.pools).map((p) => ({
					name: p.name,
					poolId: p.poolId,
					baseCoinType: p.base,
					quoteCoinType: p.quote,
				})),
			},
		};
	}),
});


// Vite spawns on a local port; the supervisor publishes a Traefik
// file-provider entry so the public URL surfaces as
// `http://dev.wallet.localhost:5175`. Ready probe targets the local
// port so we don't depend on router warm-up.
const dev = hostProcess({
	name: 'frontend.dev-server',
	command: 'pnpm',
	args: ['exec', 'vite', '--port', '5174', '--strictPort'],
	readyProbe: { kind: 'http', url: 'http://localhost:5174', timeoutMs: 60_000 },
	endpoint: { name: 'dev-server', kind: 'dev-server' },
	traefik: { service: 'dev', entrypoint: 'vite', localPort: 5174 },
	dependsOn: [usdcPublish, wethPublish, seedTokens, db, wallet],
});

export default defineDevstack([
	suiLocalnet(),
	a.publisher,
	a.alice,
	a.bob,
	a.carol,
	usdcPublish,
	wethPublish,
	musdcCoin,
	mwethCoin,
	seedTokens,
	db,
	maker,
	m,
	wallet,
	dev,
]);
