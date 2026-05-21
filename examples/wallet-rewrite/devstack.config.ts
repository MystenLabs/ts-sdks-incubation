import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	coin,
	defineDevstack,
	localPackage,
	sui,
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

const mUSDC = coin.witness(usdc, 'MOCK_USDC');
const mWETH = coin.witness(weth, 'MOCK_WETH');

const USDC_AMOUNTS = [75_000_000_000n, 10_000_000_000n, 5_000_000_000n] as const;
const WETH_AMOUNTS = [6_000_000_000n, 500_000_000n, 200_000_000n] as const;

const seedTokens = action('wallet.seedTokens', {
	consumes: [mUSDC, mWETH, publisher, alice, bob, carol] as const,
	body: (ctx) =>
		ctx.signAndExecute(ctx.use(publisher), (tx) => {
			const recipients = [ctx.use(alice).address, ctx.use(bob).address, ctx.use(carol).address];
			const mints = [
				{ c: ctx.use(mUSDC), amounts: USDC_AMOUNTS },
				{ c: ctx.use(mWETH), amounts: WETH_AMOUNTS },
			];
			for (const { c, amounts } of mints) {
				if (c.treasuryCapId === undefined) continue;
				const [pkg, mod] = c.fullCoinType.split('::');
				const target = `${pkg}::${mod}::mint` as const;
				for (let i = 0; i < recipients.length; i++) {
					tx.moveCall({
						target,
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

export default defineDevstack(
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
