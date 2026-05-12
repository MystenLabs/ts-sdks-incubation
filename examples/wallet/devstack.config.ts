// Wallet app — multi-coin wallet UI + DeepBook v3 swap. DeepBook
// itself is published + pools created via `deepbookLocalnet`; alice
// runs a continuous grid market-maker across both pools via
// `deepbookMarketMaker`. The mock USDC + WETH coins are published as
// alice, captured via `publishViaSuiCli`'s `capture:` callback, and
// surfaced through `registerCoin` so the dev-wallet faucet panel
// discovers them.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

import { defineDevstackConfig, define } from '@mysten-incubation/devstack-next';
import {
	pickCreatedByTypeIncludes,
	pickCreatedByTypeSuffix,
	publishMove,
	publishViaSuiCli,
	viteDevServer,
} from '@mysten-incubation/devstack-next/helpers';
import {
	accounts,
	deepbookLocalnet,
	deepbookMarketMaker,
	manifest,
	registerCoin,
	sui,
	walletApp,
	type DeepbookPoolsState,
} from '@mysten-incubation/devstack-next/plugins';
import type { Package } from '@mysten-incubation/devstack-next/shapes';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_DIR = resolve(HERE, 'move/mock_usdc');
const WETH_DIR = resolve(HERE, 'move/mock_weth');

// Initial token distributions (raw units, accounting for decimals).
// alice gets a healthy share since she's also the market-maker and
// needs inventory to seed + replenish her grid.
const USDC_DISTRIBUTION: ReadonlyArray<{ recipient: 'alice' | 'bob' | 'carol'; amount: bigint }> = [
	{ recipient: 'alice', amount: 75_000_000_000n }, // 75,000 USDC (6 dec)
	{ recipient: 'bob', amount: 10_000_000_000n }, // 10,000 USDC
	{ recipient: 'carol', amount: 5_000_000_000n }, // 5,000 USDC
];
const WETH_DISTRIBUTION: ReadonlyArray<{ recipient: 'alice' | 'bob' | 'carol'; amount: bigint }> = [
	{ recipient: 'alice', amount: 6_000_000_000n }, // 60 WETH (8 dec)
	{ recipient: 'bob', amount: 500_000_000n }, // 5 WETH
	{ recipient: 'carol', amount: 200_000_000n }, // 2 WETH
];

const a = accounts({ specs: { publisher: {}, alice: {}, bob: {}, carol: {} } });

// Capture helper — surfaces TreasuryCap + CoinMetadata + UpgradeCap
// on the published Package's `captured` map. The dev-wallet faucet
// panel reads `captured.treasuryCapId` to mint.
function captureCoinObjects() {
	return (changes: import('@mysten/sui/jsonRpc').SuiObjectChange[]) => {
		const out: Record<string, string> = {};
		const t = pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<');
		if (t !== undefined) out.treasuryCapId = t;
		const md = pickCreatedByTypeIncludes(changes, '::coin::CoinMetadata<');
		if (md !== undefined) out.metadataId = md;
		const up = pickCreatedByTypeSuffix(changes, '0x2::package::UpgradeCap');
		if (up !== undefined) out.upgradeCapId = up;
		return out;
	};
}

const usdcPublish = publishMove({
	name: 'mock_usdc',
	path: USDC_DIR,
	signer: a.pool.get('signer', { name: 'publisher' }),
	publish: (ctx) => publishViaSuiCli(ctx, { capture: captureCoinObjects() }),
});
const usdcCoin = registerCoin({
	name: 'musdc',
	package: usdcPublish.get('package'),
	module: 'mock_usdc',
	type: 'MOCK_USDC',
	decimals: 6,
});

const wethPublish = publishMove({
	name: 'mock_weth',
	path: WETH_DIR,
	signer: a.pool.get('signer', { name: 'publisher' }),
	publish: (ctx) => publishViaSuiCli(ctx, { capture: captureCoinObjects() }),
});
const wethCoin = registerCoin({
	name: 'mweth',
	package: wethPublish.get('package'),
	module: 'mock_weth',
	type: 'MOCK_WETH',
	decimals: 8,
});

// Token distribution: publisher mints initial USDC + WETH supply to
// alice/bob/carol. Idempotent via input-hash skip — change a recipient
// or amount and it re-fires; otherwise no-op.
const seedTokens = define<{ digest: string }>({
	name: 'wallet.seedTokens',
	runsAs: 'publisher',
	provides: {},
	deps: {
		signer: a.pool.get('signer', { name: 'publisher' }),
		rpc: sui.get('rpc'),
		usdc: usdcPublish.get('package'),
		weth: wethPublish.get('package'),
		alice: a.pool.get('address', { name: 'alice' }),
		bob: a.pool.get('address', { name: 'bob' }),
		carol: a.pool.get('address', { name: 'carol' }),
	},
	inputs: ({ deps }) => {
		const d = deps as {
			usdc: Package;
			weth: Package;
			alice: string;
			bob: string;
			carol: string;
		};
		return {
			usdcPackageId: d.usdc.packageId,
			wethPackageId: d.weth.packageId,
			usdc: USDC_DISTRIBUTION.map((e) => ({ recipient: e.recipient, amount: e.amount.toString() })),
			weth: WETH_DISTRIBUTION.map((e) => ({ recipient: e.recipient, amount: e.amount.toString() })),
			addresses: { alice: d.alice, bob: d.bob, carol: d.carol },
		};
	},
	start: async ({ deps }) => {
		const d = deps as {
			signer: Ed25519Keypair;
			rpc: { url: string };
			usdc: Package;
			weth: Package;
			alice: string;
			bob: string;
			carol: string;
		};
		const tx = new Transaction();
		tx.setGasBudget(500_000_000n);
		const addrFor = (name: 'alice' | 'bob' | 'carol'): string => d[name];
		for (const spec of [
			{ pkg: d.usdc, module: 'mock_usdc', distribution: USDC_DISTRIBUTION },
			{ pkg: d.weth, module: 'mock_weth', distribution: WETH_DISTRIBUTION },
		]) {
			const treasuryCapId = spec.pkg.captured?.treasuryCapId;
			if (treasuryCapId === undefined) {
				throw new Error(
					`seedTokens: package '${spec.pkg.name}' missing captured.treasuryCapId — capture callback regression`,
				);
			}
			const target = `${spec.pkg.packageId}::${spec.module}::mint`;
			for (const entry of spec.distribution) {
				tx.moveCall({
					target,
					arguments: [
						tx.object(treasuryCapId),
						tx.pure.u64(entry.amount),
						tx.pure.address(addrFor(entry.recipient)),
					],
				});
			}
		}
		const client = new SuiJsonRpcClient({ url: d.rpc.url, network: 'localnet' });
		const result = await client.signAndExecuteTransaction({
			signer: d.signer,
			transaction: tx,
			options: { showEffects: true },
		});
		if (result.effects?.status?.status !== 'success') {
			throw new Error(`seedTokens: ${result.effects?.status?.error ?? 'unknown'}`);
		}
		await client.waitForTransaction({ digest: result.digest });
		return { digest: result.digest };
	},
});

// Pool specs. Base/quote come from the registered coins — passing
// `usdcCoin.get('coin')` as quote lets deepbookLocalnet resolve the
// fully-qualified Move type at runtime from the published package id.
const db = deepbookLocalnet({
	signer: a.pool.get('signer', { name: 'publisher' }),
	pools: [
		{
			name: 'sui_usdc',
			base: '0x2::sui::SUI',
			quote: usdcCoin.get('coin'),
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
		{
			name: 'sui_weth',
			base: '0x2::sui::SUI',
			quote: wethCoin.get('coin'),
			tickSize: 100n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
	],
});

// Continuous liquidity: alice runs a single grid maker across both
// pools, refreshing every 10s. Long-running host process — skipped by
// Playwright globalSetup; only `pnpm dev` / `devstack-next up` start it.
// Depends on seedTokens so alice owns mUSDC + mWETH before the maker
// tries to deposit them into her BalanceManager.
const aliceMaker = deepbookMarketMaker({
	name: 'alice',
	signer: a.pool.get('signer', { name: 'alice' }),
	deepbookPackage: db.publish.get('package'),
	pools: db.pools!.get('full'),
	quotedPools: ['sui_usdc', 'sui_weth'],
	midPrices: {
		sui_usdc: 3_500_000n,
		sui_weth: 10_000n,
	},
	sizePerLevel: 1_000_000_000n,
	levels: 3,
	tickSpacing: 1,
});

const wallet = walletApp.create({
	accounts: [
		{ name: 'publisher', signer: a.pool.get('signer', { name: 'publisher' }) },
		{ name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
		{ name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
		{ name: 'carol', signer: a.pool.get('signer', { name: 'carol' }) },
	],
	allowedOrigins: ['http://localhost:5174'],
});

const m = manifest({
	packages: [
		usdcPublish.get('package'),
		wethPublish.get('package'),
		db.publish.get('package'),
	],
	endpoints: [sui.get('endpoint'), sui.get('faucetEndpoint'), wallet.get('endpoint')],
	accounts: [
		a.pool.get('account', { name: 'publisher' }),
		a.pool.get('account', { name: 'alice' }),
		a.pool.get('account', { name: 'bob' }),
		a.pool.get('account', { name: 'carol' }),
	],
	coins: [usdcCoin.get('coin'), wethCoin.get('coin')],
	extras: {
		// Pool list for the swap UI — keyed by pool name, with poolId
		// + base/quote types so the frontend doesn't need to grep the
		// packages list.
		deepbookPools: db.pools!.get('full'),
	},
});

const dev = viteDevServer({
	port: 5174,
	gates: [
		usdcPublish.get('package'),
		wethPublish.get('package'),
		db.publish.get('package'),
		db.pools!.get('full'),
		wallet.get('full'),
	],
});

export default defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }),
		a.pool,
		a.fund,
		usdcPublish,
		usdcCoin,
		wethPublish,
		wethCoin,
		seedTokens,
		db.source,
		db.publish,
		db.pools!,
		aliceMaker,
		m,
		wallet,
		dev,
	],
});

// Suppress "unused" type imports on tooling that doesn't trace through
// JSDoc / inline annotations.
export type _Unused = DeepbookPoolsState;
