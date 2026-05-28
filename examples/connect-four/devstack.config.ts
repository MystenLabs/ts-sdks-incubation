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
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5176;

const localnet = sui();
const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const connectFour = localPackage('connect_four', {
	sourcePath: resolve(HERE, 'move', 'connect_four'),
	publisher,
});

const openLobby = action('connect-four.openLobby', {
	dependsOn: { signer: alice, pkg: connectFour },
	body: (ctx, { signer, pkg }) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});
const devWallet = wallet({
	accounts: [alice, bob, publisher],
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [openLobby, devWallet] as const,
});
const stack: Stack = defineDevstack({ members: [localnet, app], stackName: 'connect-four' });

export default stack;
