import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	coin,
	defineDevstack,
	localPackage,
	sui,
	type AnyMember,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack-rewrite';

import { WALLET_REWRITE_DEV_ORIGIN } from './dev-origin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');
const carol = account('carol');

const usdc = localPackage('mock_usdc', {
	sourcePath: resolve(HERE, 'move/mock_usdc'),
	publisher,
});
const weth = localPackage('mock_weth', {
	sourcePath: resolve(HERE, 'move/mock_weth'),
	publisher,
});

const mUSDC = coin.fromPackage(usdc, 'MOCK_USDC');
const mWETH = coin.fromPackage(weth, 'MOCK_WETH');

const USDC_AMOUNTS = [75_000_000_000n, 10_000_000_000n, 5_000_000_000n] as const;
const WETH_AMOUNTS = [6_000_000_000n, 500_000_000n, 200_000_000n] as const;

const seedTokens = action('wallet.seedTokens', {
	consumes: [usdc, weth, publisher, alice, bob, carol] as const,
	body: (ctx) =>
		ctx.signAndExecute(ctx.use(publisher), (tx) => {
			const recipients = [ctx.use(alice).address, ctx.use(bob).address, ctx.use(carol).address];
			const usdcPkg = ctx.use(usdc);
			const wethPkg = ctx.use(weth);
			const mints = [
				{ pkg: usdcPkg, c: usdcPkg.coins.mock_usdc, module: 'mock_usdc', amounts: USDC_AMOUNTS },
				{ pkg: wethPkg, c: wethPkg.coins.mock_weth, module: 'mock_weth', amounts: WETH_AMOUNTS },
			];
			for (const { pkg, c, module, amounts } of mints) {
				if (c?.treasuryCapId === undefined) continue;
				for (let i = 0; i < recipients.length; i++) {
					tx.moveCall({
						target: `${pkg.packageId}::${module}::mint`,
						arguments: [
							tx.object(c.treasuryCapId),
							tx.pure.u64(amounts[i]!),
							tx.pure.address(recipients[i]!),
						],
					});
				}
			}
		}),
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	sui(),
	publisher,
	alice,
	bob,
	carol,
	usdc,
	weth,
	mUSDC,
	mWETH,
	seedTokens,
	wallet({ accounts: [publisher, alice, bob, carol], allowedOrigins: [WALLET_REWRITE_DEV_ORIGIN] }),
	{ stackName: 'wallet-rewrite' },
);

export default stack;
