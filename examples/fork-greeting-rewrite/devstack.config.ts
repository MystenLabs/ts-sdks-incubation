import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const greeting = localPackage('greeting', {
	sourcePath: resolve(HERE, '..', 'fork-greeting', 'move', 'greeting'),
	publisher,
});

export default defineDevstack(
	sui(),
	publisher,
	alice,
	bob,
	greeting,
	wallet({
		accounts: [publisher, alice, bob],
		allowLocalhostVite: true,
		allowedOrigins: ['http://dev.fork-greeting-rewrite.localhost:5181', 'http://localhost:5181'],
	}),
	{ stackName: 'fork-greeting-rewrite' },
);
