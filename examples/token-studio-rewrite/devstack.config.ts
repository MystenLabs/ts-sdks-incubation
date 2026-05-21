import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	coin,
	defineDevstack,
	localPackage,
	sui,
	type AnyMember,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ORIGIN = 'http://127.0.0.1:5173';

const alice = account('alice');
const bob = account('bob');
const carol = account('carol');

const managedCoin = localPackage('managed_coin', {
	sourcePath: resolve(HERE, 'move/managed_coin'),
	publisher: alice,
});
const studioCoin = coin.fromPackage(managedCoin, 'MANAGED_COIN');

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	sui(),
	alice,
	bob,
	carol,
	managedCoin,
	studioCoin,
	wallet({ accounts: [alice, bob, carol], allowedOrigins: [DEV_ORIGIN] }),
	{ stackName: 'token-studio-rewrite' },
);

export default stack;
