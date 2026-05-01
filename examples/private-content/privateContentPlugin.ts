// Private-content's app plugin. Owns one action:
//
//   private-content.vault — Publish the on-chain vault package
//                           (`examples/private-content/move/vault`). Source-digest
//                          gate (M8) skips republish when sources are
//                          unchanged and the cached packageId is still live
//                          on chain.
//
// The vault Move module has no `use seal::...` import — Seal access control
// runs entirely client-side via SessionKey + the vault::vault::seal_approve
// dry-run policy fn. So vault publish only needs `sui.accounts`; the seal
// key-server stack ([sui, walrus, seal]) comes up in parallel because all
// three are listed in the app's `plugins:`.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, definePublishAction } from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, 'move/vault');

export const privateContentPlugin = () =>
	definePlugin({
		name: 'private-content',
		actions: () => [
			definePublishAction({
				name: 'vault',
				needs: ['sui.accounts'],
				sourcePath: VAULT_DIR,
			}),
		],
	});
