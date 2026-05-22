import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	localPackage,
	sui,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));

const forkedNetwork = sui({ mode: 'fork', upstream: 'testnet' });
const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const greeting = localPackage('greeting', {
	sourcePath: resolve(HERE, 'move', 'greeting'),
	publisher,
	capture: { boardId: '::board::Board' },
});
const devWallet = wallet({
	accounts: [publisher, alice, bob],
});
const stack: Stack = defineDevstack({
	members: [forkedNetwork, greeting, devWallet],
	stackName: 'fork-greeting',
});

export default stack;
