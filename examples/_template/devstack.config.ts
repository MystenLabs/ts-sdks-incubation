// Minimal devstack config template.
//
// Two accounts + a local Move package. The package's `publisher`
// threads the account member directly (Direct Member Ref). The
// substrate orders alice's keypair + funding strictly before the
// publish tx via the package's dependency edge.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	account,
	localPackage,
	sui,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5179;

const localnet = sui();
const alice = account('alice');
const bob = account('bob');

const hello = localPackage('hello', {
	sourcePath: resolve(HERE, 'move/hello'),
	publisher: alice,
});
const devWallet = wallet({
	accounts: [alice, bob],
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 127.0.0.1 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	env: {
		VITE_TEMPLATE_AUTO_APPROVE: '1',
	},
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [hello, devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app], stackName: 'main' });

export default stack;
