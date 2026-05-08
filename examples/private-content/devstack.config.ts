// Private-content app — Seal-encrypted file vault on top of sui-localnet,
// walrus, and a single Open-mode seal key server. The vault Move package
// is published via an entry in the app's `use:` (no client-side `use seal::`
// import; access control runs entirely client-side via SessionKey + the
// `vault::vault::seal_approve` dry-run policy fn).
//
// First `pnpm devstack up` builds two heavy local arm64 images:
// walrus-service (~10 min) and seal (~5–8 min). Subsequent `up`s hit the
// docker layer cache and complete in seconds.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	codegen,
	defineDevstackConfig,
	frontend,
	publishMove,
	seal,
	sui,
	walletApp,
	walrus,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, 'move/vault');

export default defineDevstackConfig({
	app: 'private-content',
	accounts: ['publisher', 'alice', 'bob'],
	use: [
		// Plugin port options are hints to the per-stack port allocator;
		// the allocator picks any free port if a sibling stack has the
		// preferred port claimed.
		sui({ version: 'devnet-v1.71.0', rpcPort: 9482, faucetPort: 9871 }),
		accounts(),
		walrus(),
		seal(),
		codegen(),
		walletApp({ port: 9423 }),
		frontend({ port: 5175 }),
		publishMove({
			name: 'vault',
			path: VAULT_DIR,
		}),
	],
});
