import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	deepbook,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	sui,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5182;

const localnet = sui();
const alice = account('alice');

const dex = deepbook({
	mode: 'known',
	network: 'testnet',
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	needs: [localnet, alice, dex] as const,
});

const stack = defineDevstack({ members: [localnet, app] });

export default stack;
