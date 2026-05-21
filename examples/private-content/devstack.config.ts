import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	account,
	localPackage,
	type AnyMember,
	type Stack,
	wallet,
	walrus,
	seal,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const vault = localPackage('vault', {
	sourcePath: resolve(HERE, 'move/vault'),
	publisher,
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	publisher,
	alice,
	bob,
	vault,
	walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] } }),
	seal({ mode: 'local-keygen', signer: publisher }),
	wallet({ accounts: 'all' }),
);

export default stack;
