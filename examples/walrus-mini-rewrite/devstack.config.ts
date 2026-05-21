// walrus-mini — smallest walrus-using devstack-rewrite example.
//
// Stand-in target for the (not-yet-ported) `fork-greeting-rewrite`
// and `private-content-rewrite` walrus examples. Composes the
// absolute minimum for the walrus plugin's local-cluster boot path:
// sui() localnet, account('admin') seed, and a 1-node / 4-shard
// walrus cluster pointing at a local Move stub package so the
// lifted `git fetch` of the upstream walrus source is short-circuited.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineDevstack, sui, account, walrus } from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALRUS_STUB_DIR = resolve(HERE, 'move/walrus_stub');

const admin = account('admin');

// Shards must be >= nodeCount (synchronous guard in
// `mode/local-cluster.ts::resolveLocalClusterOptions`).
const walrusPlugin = walrus({
	local: {
		name: 'walrus',
		nodeCount: 1,
		shards: 4,
		movePackagePath: WALRUS_STUB_DIR,
	},
});

export default defineDevstack(sui(), admin, walrusPlugin, {
	stackName: 'walrus-mini-rewrite',
});
