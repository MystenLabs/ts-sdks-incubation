import { describe, expect, it } from 'vitest';

// Sorted, deduped list of named exports from each subpath barrel.
// Adding or removing an export here will fail this test — the snapshot
// makes the public-surface change visible in review. Update the
// inline lists below intentionally; that's the gate.

import * as root from './index.js';
import * as dappKit from './dapp-kit/index.js';
import * as helpers from './helpers/index.js';
import * as persistence from './persistence/index.js';
import * as playwright from './playwright/index.js';
import * as plugins from './plugins/index.js';
import * as shapes from './shapes/index.js';
import * as vitestSubpath from './vitest/index.js';

function keys(mod: Record<string, unknown>): string[] {
	return Object.keys(mod)
		.filter((k) => k !== 'default')
		.sort();
}

describe('public API surface', () => {
	it('root (@mysten-incubation/devstack) exports', () => {
		expect(keys(root)).toMatchInlineSnapshot(`
			[
			  "BuildError",
			  "CycleError",
			  "DEVSTACK_VERSION",
			  "Engine",
			  "accountPool",
			  "attachFileWatcher",
			  "buildGraph",
			  "define",
			  "defineDevstackConfig",
			  "defineSchema",
			  "dep",
			  "dockerContainer",
			  "dockerImage",
			  "dockerNetwork",
			  "dockerNetworkOctet",
			  "dockerOneShot",
			  "exclusiveDep",
			  "hostProcess",
			  "ports",
			]
		`);
	});

	it('./dapp-kit exports', () => {
		expect(keys(dappKit)).toMatchInlineSnapshot(`
			[
			  "createDevstackDappKit",
			  "localnetDappKitConfig",
			  "localnetMvrOverrides",
			  "localnetWalrusOptions",
			]
		`);
	});

	it('./helpers exports', () => {
		expect(keys(helpers)).toMatchInlineSnapshot(`
			[
			  "cliSigner",
			  "envSigner",
			  "extractTrailingJson",
			  "gitFetch",
			  "hashMoveTree",
			  "pickCreatedByTypeIncludes",
			  "pickCreatedByTypeSuffix",
			  "publishMove",
			  "publishViaSuiCli",
			  "runTransaction",
			  "viteDevServer",
			]
		`);
	});

	it('./persistence exports', () => {
		expect(keys(persistence)).toMatchInlineSnapshot(`
			[
			  "StackLockBusyError",
			  "acquireStackLock",
			  "devstackDir",
			  "inspectStackLock",
			  "labeledSnapshotPath",
			  "labeledSnapshotsDir",
			  "snapshotPathFor",
			  "stackLockPath",
			  "tryReadSnapshot",
			  "withStackLock",
			  "writeJsonAtomic",
			  "writeSnapshot",
			]
		`);
	});

	it('./playwright exports', () => {
		expect(keys(playwright)).toMatchInlineSnapshot(`
			[
			  "connectAs",
			  "createDevstackTest",
			  "expect",
			  "readManifest",
			  "selectAccount",
			  "setup",
			  "teardown",
			  "test",
			  "waitForBalanceUpdate",
			  "webServer",
			]
		`);
	});

	it('./plugins exports', () => {
		expect(keys(plugins)).toMatchInlineSnapshot(`
			[
			  "WALLET_APP_PORT_SLOT",
			  "accounts",
			  "bindings",
			  "deepbook",
			  "deepbookLocalnet",
			  "deepbookMarketMaker",
			  "keystoreDir",
			  "manifest",
			  "registerCoin",
			  "renderManifest",
			  "seal",
			  "sealLocalnet",
			  "sui",
			  "walletApp",
			  "walrus",
			  "walrusProxy",
			  "walrusSeedWal",
			]
		`);
	});

	it('./shapes exports', () => {
		expect(keys(shapes)).toMatchInlineSnapshot(`[]`);
	});

	it('./vitest exports', () => {
		expect(keys(vitestSubpath)).toMatchInlineSnapshot(`
			[
			  "getNodeState",
			  "readManifest",
			  "readSnapshot",
			  "setup",
			  "setupWithConfig",
			  "teardown",
			]
		`);
	});
});
