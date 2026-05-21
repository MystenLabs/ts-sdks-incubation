// Minimal devstack config — rewrite template.
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
	wallet,
} from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ORIGIN = 'http://127.0.0.1:5179';

const alice = account('alice');
const bob = account('bob');

const hello = localPackage('hello', {
	sourcePath: resolve(HERE, 'move/hello'),
	publisher: alice,
});

export default defineDevstack(
	sui(),
	alice,
	bob,
	hello,
	wallet({ accounts: [alice, bob], allowedOrigins: [DEV_ORIGIN] }),
	{
		stackName: '_template-rewrite',
	},
);
