// Devstack template config (superset).
//
// Core: a sui localnet, one managed account (alice), a local `counter`
// Move package, the dev wallet, and a vite host service.
//
// Optional plugins are wrapped in devstack begin/end plugin fences (see
// src/strip.ts for the exact marker syntax) so the scaffolder can strip the
// ones a user opts out of. Fences sit on whole-statement boundaries (imports,
// const declarations, array elements, `after:` members) so removal never
// breaks syntax.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	dashboard,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	type Stack,
	wallet,
	// devstack:begin deepbook
	deepbook,
	// devstack:end deepbook
	// devstack:begin seal
	seal,
	// devstack:end seal
	// devstack:begin walrus
	walrus,
	walCoin,
	// devstack:end walrus
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5179;

const localnet = sui();

// devstack:begin walrus
const walrusCluster = walrus({ local: { nodeCount: 1 } });
const wal = walCoin(walrusCluster);
// devstack:end walrus

const alice = account('alice', {
	kind: 'ephemeral',
	funding: [
		{ coin: 'sui', amount: 1_000_000_000n },
		// devstack:begin walrus
		{ coin: wal, amount: 500_000_000n },
		// devstack:end walrus
	],
});

const counter = localPackage('counter', {
	sourcePath: resolve(HERE, 'move/counter'),
	publisher: alice,
});

// devstack:begin seal
const sealPublisher = account('seal_publisher', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000n }],
});
const vault = localPackage('vault', {
	sourcePath: resolve(HERE, 'move/vault'),
	publisher: sealPublisher,
});
const sealKeyServer = seal({ mode: 'local-keygen', signer: sealPublisher });
// devstack:end seal

// devstack:begin deepbook
// One-liner local DeX: synthesizes a publisher, publishes DeepBook + Pyth
// from the plugin's bundled assets, and seeds a default DEEP/SUI pool.
const dex = deepbook();
// devstack:end deepbook

const devWallet = wallet({
	accounts: [
		alice,
		// devstack:begin seal
		sealPublisher,
		// devstack:end seal
	],
});

const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [
		localnet,
		counter,
		devWallet,
		// devstack:begin walrus
		walrusCluster,
		// devstack:end walrus
		// devstack:begin seal
		vault,
		sealKeyServer,
		// devstack:end seal
		// devstack:begin deepbook
		dex,
		// devstack:end deepbook
	] as const,
});

const stack: Stack = defineDevstack({
	members: [localnet, app, dashboard()],
	stackName: 'template',
});

export default stack;
