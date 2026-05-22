import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5181;
const ROUTER_DEV_ORIGIN = 'http://dev.fork-greeting.fork-greeting.localhost:5175' as const;

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const greeting = localPackage('greeting', {
	sourcePath: resolve(HERE, '..', 'fork-greeting', 'move', 'greeting'),
	publisher,
	capture: { boardId: '::board::Board' },
});
const devWallet = wallet({
	accounts: [publisher, alice, bob],
	allowLocalhostVite: true,
	allowedOrigins: [ROUTER_DEV_ORIGIN, `http://localhost:${DEV_PORT}`],
});
const stack = defineDevstack({ members: [sui(), publisher, alice, bob, greeting, devWallet], stackName: 'fork-greeting' });

export default stack;
