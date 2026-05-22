import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	coin,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack';

import {
	WALLET_DEV_ORIGIN,
	WALLET_DEV_SERVER_PORT,
	WALLET_ROUTER_DEV_ORIGIN,
} from './dev-origin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const localnet = sui();
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
	dependsOn: { usdc, weth, publisher, alice, bob, carol },
	body: (ctx, { usdc, weth, publisher, alice, bob, carol }) =>
		ctx.signAndExecute(publisher, (tx) => {
			const recipients = [alice.address, bob.address, carol.address];
			const mints = [
				{ pkg: usdc, c: usdc.coins.mock_usdc, module: 'mock_usdc', amounts: USDC_AMOUNTS },
				{ pkg: weth, c: weth.coins.mock_weth, module: 'mock_weth', amounts: WETH_AMOUNTS },
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
const devWallet = wallet({
	accounts: [publisher, alice, bob, carol],
	enableRouter: true,
	allowedOrigins: [WALLET_DEV_ORIGIN, WALLET_ROUTER_DEV_ORIGIN],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: WALLET_DEV_SERVER_PORT,
	ready: { kind: 'http' },
	needs: [usdc, weth, mUSDC, mWETH, seedTokens, devWallet] as const,
});

const stack = defineDevstack({ members: [localnet, app], stackName: 'wallet' });

export default stack;
