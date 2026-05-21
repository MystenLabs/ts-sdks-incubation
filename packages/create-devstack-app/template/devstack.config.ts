// Minimal devstack config template.
//
// Two accounts + a local Move package. The package's `publisher`
// threads the account member directly (Direct Member Ref). The
// substrate orders alice's keypair + funding strictly before the
// publish tx via the package's `consumes:` edge.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	sui,
	account,
	localPackage,
	type AnyMember,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ORIGIN = 'http://127.0.0.1:5179';

const alice = account('alice');
const bob = account('bob');

const hello = localPackage('hello', {
	sourcePath: resolve(HERE, 'move/hello'),
	publisher: alice,
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	sui(),
	alice,
	bob,
	hello,
	wallet({ accounts: [alice, bob], allowedOrigins: [DEV_ORIGIN] }),
	{
		stackName: '_template',
	},
);

export default stack;
