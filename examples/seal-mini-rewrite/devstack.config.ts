// seal-mini — smallest seal-using devstack-rewrite example.
//
// Stand-in target for the (not-yet-ported) `private-content-rewrite`
// seal example. Composes the absolute minimum for the seal plugin's
// local-keygen boot path: sui() localnet, account('admin') seed, and
// a local-keygen seal pointing at a local Move stub package so the
// lifted `git fetch` of the upstream seal source is short-circuited.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineDevstack, sui, account, seal } from '@mysten-incubation/devstack-rewrite';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL_STUB_DIR = resolve(HERE, 'move/seal_stub');

const admin = account('admin');

// Local-keygen mode: signer is required for the publish + on-chain
// register one-shots. `movePackagePath` short-circuits the lifted
// git-source sibling against the example's `move/seal_stub/` subtree.
const sealPlugin = seal({
	mode: 'local-keygen',
	name: 'seal',
	signer: admin,
	movePackagePath: SEAL_STUB_DIR,
});

export default defineDevstack(sui(), admin, sealPlugin, {
	stackName: 'seal-mini-rewrite',
});
