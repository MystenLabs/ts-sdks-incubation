import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	defineDevstack,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const connectFour = localPackage('connect_four', {
	sourcePath: resolve(HERE, '..', 'arena', 'move', 'connect_four'),
	publisher,
});

const openLobby = action('arena.openLobby', {
	consumes: [alice, connectFour] as const,
	body: (ctx) =>
		ctx.signAndExecute(ctx.use(alice), (tx) => {
			const pkg = ctx.use(connectFour);
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});

export default defineDevstack(
	sui(),
	publisher,
	alice,
	bob,
	connectFour,
	openLobby,
	wallet({
		accounts: [alice, bob, publisher],
		allowLocalhostVite: true,
		allowedOrigins: ['http://dev.arena-rewrite.localhost:5176', 'http://localhost:5176'],
	}),
	{ stackName: 'arena-rewrite' },
);
