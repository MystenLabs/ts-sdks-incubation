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
	Coin,
	Deepbook,
	DeepbookMarketMaker,
	Dev,
	devstack,
	Package,
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

// Coin auto-discovery surfaces every coin the publish creates as
// `pkg.coins[<symbol>]` (the on-chain CoinMetadata symbol). For the two
// mock coins below the symbols are `mUSDC` and `mWETH`. The
// per-treasury-cap mint strategy registers automatically with the
// auto-included Faucet, so dev-wallet's "Get mUSDC" / "Get mWETH"
// buttons work end-to-end without explicit faucet wiring.
const usdc = Package('mock_usdc', USDC_DIR, { signer: publisher });
const weth = Package('mock_weth', WETH_DIR, { signer: publisher });

// Coin refs surface the runtime Move type so deepbook pools can
// reference locally-published coins without static knowledge of the
// post-publish package id. `Coin.fromPackage(pkg, witness)` yields the
// publishing Package first (forcing the dependency edge) then reads the
// auto-discovered coin record off `pkg.coins`. The witness name is the
// Move type from `coin::create_currency<W>` — case-insensitive lookup
// matches either the witness (`'MOCK_USDC'`) or the canonical symbol
// (`'mUSDC'`).
const musdc = Coin.fromPackage(usdc, 'MOCK_USDC');
const mweth = Coin.fromPackage(weth, 'MOCK_WETH');

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
			// `pkg.coins[<symbol>]` is populated by coin auto-discovery —
			// the symbol is what each Move source's `coin::create_currency`
			// declares as the third byte-string argument (`b"mUSDC"`,
			// `b"mWETH"`). Each entry carries the resolved `treasuryCapId`
			// captured from the publish receipt.
			for (const spec of [
				{ pkg: usdcPkg, symbol: 'mUSDC', module: 'mock_usdc', distribution: USDC_DISTRIBUTION },
				{ pkg: wethPkg, symbol: 'mWETH', module: 'mock_weth', distribution: WETH_DISTRIBUTION },
			]) {
				const coin = spec.pkg.coins[spec.symbol];
				const treasuryCapId = coin?.treasuryCapId;
				if (treasuryCapId === undefined) {
					yield* Effect.die(
						`seedTokens: package '${spec.pkg.name}' missing coins.${spec.symbol}.treasuryCapId`,
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
	strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 3 },
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

// No `extras:` block — the codegen `DeepbookConfigEmitter` now emits
// `src/generated/deepbook-config.ts` with the typed pool + coin +
// packageIds projection. Consumers (`src/lib/transactions.ts`) import
// `deepbookConfig` directly and spread it into
// `client.$extend(deepbook(...))`. The previous manual `extras.deepbookPools`
// projection was deleted in Phase 5 of the deepbook plugin expansion
// (see packages/devstack/notes/deepbook-plugin-expansion.md § P5.12).
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
);
