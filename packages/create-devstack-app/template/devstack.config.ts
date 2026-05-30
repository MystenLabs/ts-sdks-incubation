// Minimal devstack config template.
//
// Two accounts + a local Move package + one post-publish action.
// The package's `publisher` threads the account member directly
// (Direct Member Ref). The substrate orders alice's keypair +
// funding strictly before the publish tx via the package's
// dependency edge; the action then runs once the package is on chain.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	action,
	dashboard,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
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
const greet = action('template.greet', {
	dependsOn: { signer: alice, pkg: hello },
	body: (ctx, { signer, pkg }) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({
				target: `${pkg.packageId}::hello::mint`,
				arguments: [tx.pure.vector('u8', [...new TextEncoder().encode('hello')])],
			});
		}),
});
const devWallet = wallet({
	accounts: [alice, bob],
});
const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [greet, devWallet] as const,
});

const stack: Stack = defineDevstack({ members: [localnet, app, dashboard()], stackName: 'template' });

export default stack;
