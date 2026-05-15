// Minimal devstack config: sui localnet, manifest, wallet-app, vite
// frontend, and one Move transaction after publish to demonstrate the
// setup pattern.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import {
	accounts,
	defineDevstack,
	hostProcess,
	manifest,
	publishMove,
	suiLocalnet,
	tx,
	walletApp,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_DIR = resolve(HERE, 'move/hello');

const a = accounts({ alice: {}, bob: {} });

const helloPublish = publishMove({
	name: 'hello',
	path: HELLO_DIR,
	signer: a.alice,
});

const mintGreeting = tx({
	name: 'mint-greeting',
	signer: a.alice,
	dependsOn: [helloPublish],
	build: (t) =>
		Effect.gen(function* () {
			const pkg = yield* helloPublish;
			t.moveCall({
				target: `${pkg.packageId}::hello::mint`,
				arguments: [t.pure.vector('u8', Array.from(new TextEncoder().encode('hello, sui')))],
			});
		}),
});

const wallet = walletApp({
	accounts: [a.alice, a.bob],
	// Frontend serves on 5179; walletApp listens on its own default
	// (5180) and we whitelist the frontend's origin for CORS.
	allowedOrigins: ['http://localhost:5179'],
});

// Vite dev server — pin to the port Playwright's webServer config uses.
// Spawned by the supervisor so `pnpm dev` brings up vite alongside the
// stack. `dependsOn` gates the spawn until publish + wallet are ready so
// the browser doesn't load the page before the manifest is on disk.
const dev = hostProcess({
	name: 'frontend.dev-server',
	command: 'pnpm',
	args: ['exec', 'vite', '--port', '5179'],
	readyProbe: { kind: 'http', url: 'http://localhost:5179', timeoutMs: 60_000 },
	endpoint: { name: 'dev-server', kind: 'dev-server' },
	dependsOn: [helloPublish, wallet],
});

const m = manifest();

export default defineDevstack([
	suiLocalnet(),
	a.alice,
	a.bob,
	helloPublish,
	mintGreeting,
	m,
	wallet,
	dev,
]);
