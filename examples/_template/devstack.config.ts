// Minimal devstack config: sui localnet, codegen, wallet-server, vite
// frontend, and one Move package published as alice. Runs a single
// `runTransaction` after publish to demonstrate the setup pattern.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	codegen,
	defineDevstackConfig,
	frontend,
	publishMove,
	runTransaction,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_DIR = resolve(HERE, 'move/hello');

export default defineDevstackConfig({
	app: '_template',
	accounts: ['alice', 'bob'],
	use: [
		// Port hints — the per-stack allocator picks any free port if a
		// sibling stack has the preferred port claimed.
		sui({ rpcPort: 9100, faucetPort: 9101 }),
		accounts(),
		codegen(),
		walletServer({ port: 9102 }),
		frontend({ port: 5180 }),
		publishMove({
			name: 'hello',
			path: HELLO_DIR,
			publisher: 'alice',
		}),
		// Demonstrates the runTransaction shape — fires once after publish,
		// idempotent via the input-hash marker file at <stackDir>/setup/.
		runTransaction({
			name: 'mint-greeting',
			needs: ['hello'],
			signer: 'alice',
			build: (ctx, tx) => {
				const pkg = ctx.registry.packages.require('hello');
				tx.moveCall({
					target: `${pkg.packageId}::hello::mint`,
					arguments: [tx.pure.vector('u8', Array.from(new TextEncoder().encode('hello, sui')))],
				});
			},
		}),
	],
});
