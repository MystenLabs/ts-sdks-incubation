import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	wallet,
	walrus,
	seal,
	sui,
	type Stack,
} from '@mysten-incubation/devstack';

import {
	PRIVATE_CONTENT_APP_ORIGIN,
	PRIVATE_CONTENT_LOCALHOST_ORIGIN,
	PRIVATE_CONTENT_APP_PORT,
	PRIVATE_CONTENT_ROUTER_ORIGIN,
} from './devstack.shared.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const localnet = sui();
const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const vault = localPackage('vault', {
	sourcePath: resolve(HERE, 'move/vault'),
	publisher,
});
const walrusCluster = walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] } });
const sealKeyServer = seal({ mode: 'local-keygen', signer: publisher });
const devWallet = wallet({
	accounts: 'all',
	enableRouter: true,
	allowLocalhostVite: true,
	allowedOrigins: [
		PRIVATE_CONTENT_APP_ORIGIN,
		PRIVATE_CONTENT_LOCALHOST_ORIGIN,
		PRIVATE_CONTENT_ROUTER_ORIGIN,
	],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: PRIVATE_CONTENT_APP_PORT,
	ready: { kind: 'http' },
	after: [localnet, vault, walrusCluster, sealKeyServer, devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app] });

export default stack;
