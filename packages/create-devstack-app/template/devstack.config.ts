// Devstack template config (core).
//
// Core: a sui localnet, one managed account (alice), a local `counter` Move
// package, the dev wallet, and a vite host service.
//
// Optional plugins (walrus, seal, deepbook) are NOT wired here. Each lives in
// its own module under `src/devstack/`, and `src/devstack/plugins.ts` lists the
// ones this app includes. `create-devstack-app` rewrites that one barrel at
// scaffold time to drop the plugins you opted out of; this file composes
// whatever it exports. Nothing in this file is spliced or stripped.

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
} from '@mysten-incubation/devstack';

import type { FundingEntry } from './src/devstack/contribution.js';
import { OPTIONAL_PLUGINS } from './src/devstack/plugins.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5179;

const localnet = sui();

// Compose the selected optional plugins' contributions once, in declaration
// order, then spread each slot into the core members below.
const contributions = OPTIONAL_PLUGINS.map((p) => p.setup({ here: HERE }));
const pluginFunding = contributions.flatMap((c) => c.fundingForAlice ?? []);
const pluginWalletAccounts = contributions.flatMap((c) => c.walletAccounts ?? []);
const pluginAfter = contributions.flatMap((c) => c.after ?? []);

const alice = account('alice', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000n } as FundingEntry, ...pluginFunding],
});

const counter = localPackage('counter', {
	sourcePath: resolve(HERE, 'move/counter'),
	publisher: alice,
});

const devWallet = wallet({
	accounts: [alice, ...pluginWalletAccounts],
});

const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 0.0.0.0 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [localnet, counter, devWallet, ...pluginAfter],
});

const stack: Stack = defineDevstack({
	members: [localnet, app, dashboard()],
	stackName: 'template',
});

export default stack;
