import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	localPackage,
	sui,
	type AnyMember,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const greeting = localPackage('greeting', {
	sourcePath: resolve(HERE, '..', 'fork-greeting', 'move', 'greeting'),
	publisher,
	capture: { boardId: '::board::Board' },
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	sui(),
	publisher,
	alice,
	bob,
	greeting,
	wallet({
		accounts: [publisher, alice, bob],
		allowLocalhostVite: true,
		allowedOrigins: ['http://dev.fork-greeting.localhost:5181', 'http://localhost:5181'],
	}),
	{ stackName: 'fork-greeting' },
);

export default stack;
