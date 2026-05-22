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
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5179;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}` as const;
const ROUTER_DEV_ORIGIN = 'http://dev.template.localhost:5175' as const;

const localnet = sui();
const alice = account('alice');
const bob = account('bob');

const hello = localPackage('hello', {
	sourcePath: resolve(HERE, 'move/hello'),
	publisher: alice,
});
const devWallet = wallet({
	accounts: [alice, bob],
	allowedOrigins: [DEV_ORIGIN, ROUTER_DEV_ORIGIN],
});
const app = hostService({
	name: 'app',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '127.0.0.1', '--strictPort', '--port', HOST_SERVICE_PORT_TOKEN],
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	needs: [hello, devWallet] as const,
});

const stack = defineDevstack({ members: [localnet, app], stackName: 'main' });

export default stack;
