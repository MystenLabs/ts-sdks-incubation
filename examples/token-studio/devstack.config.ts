import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	coin,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}` as const;
const ROUTER_DEV_ORIGIN = 'http://dev.token-studio.token-studio.localhost:5175' as const;

const localnet = sui();
const alice = account('alice');
const bob = account('bob');
const carol = account('carol');

const managedCoin = localPackage('managed_coin', {
	sourcePath: resolve(HERE, 'move/managed_coin'),
	publisher: alice,
});
const studioCoin = coin.fromPackage(managedCoin, 'MANAGED_COIN');
const devWallet = wallet({
	accounts: [alice, bob, carol],
	enableRouter: true,
	allowedOrigins: [DEV_ORIGIN, ROUTER_DEV_ORIGIN],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	needs: [managedCoin, studioCoin, devWallet] as const,
});

const stack = defineDevstack({ members: [localnet, app], stackName: 'token-studio' });

export default stack;
