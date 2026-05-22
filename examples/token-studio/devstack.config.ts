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
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5173;

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
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 127.0.0.1 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [managedCoin, studioCoin, devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app], stackName: 'token-studio' });

export default stack;
