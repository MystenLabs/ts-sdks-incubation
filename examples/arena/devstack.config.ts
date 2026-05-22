import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5176;
const LOCALHOST_DEV_ORIGIN = `http://localhost:${DEV_PORT}` as const;
const LOOPBACK_DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}` as const;
const ROUTER_DEV_ORIGIN = 'http://dev.arena.arena.localhost:5175' as const;

const localnet = sui();
const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const connectFour = localPackage('connect_four', {
	sourcePath: resolve(HERE, '..', 'arena', 'move', 'connect_four'),
	publisher,
});

const openLobby = action('arena.openLobby', {
	dependsOn: { signer: alice, pkg: connectFour },
	body: (ctx, { signer, pkg }) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});
const devWallet = wallet({
	accounts: [alice, bob, publisher],
	enableRouter: true,
	allowLocalhostVite: true,
	allowedOrigins: [ROUTER_DEV_ORIGIN, LOCALHOST_DEV_ORIGIN, LOOPBACK_DEV_ORIGIN],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	needs: [openLobby, devWallet] as const,
});
const stack = defineDevstack({ members: [localnet, app], stackName: 'arena' });

export default stack;
