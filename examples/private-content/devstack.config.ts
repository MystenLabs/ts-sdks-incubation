// Private-content app — Seal-encrypted file vault on top of sui-localnet,
// walrus, and a single Open-mode seal key server. The vault Move
// package is published as the publisher; access control runs entirely
// client-side via SessionKey + the `vault::vault::seal_approve` dry-run
// policy fn.
//
// First `pnpm dev` builds two heavy local images: walrus (~10 min cold)
// and seal (~5–8 min). Subsequent runs hit the docker layer cache.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import {
	Account,
	Codegen,
	Dev,
	devstack,
	Package,
	Seal,
	SealKeyServerTag,
	Wallet,
	Walrus,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, 'move/vault');

const publisher = Account('publisher');
const alice = Account('alice');
const bob = Account('bob');

const vault = Package('vault', VAULT_DIR, { signer: publisher });

// Walrus storage committee (4 nodes) + proxy + WAL seeding for the
// publisher/alice/bob accounts.
const walrus = Walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] } });

// Single Seal key server in Open mode. publisher pays the on-chain
// registration tx; the keypair + KeyServer object id are cached across
// runs via StateStore (regenerated only on chain regenesis).
const seal = Seal({ signer: publisher });

const wallet = Wallet({
	accounts: [alice, bob, publisher],
	allowedOrigins: ['http://dev.private-content.localhost:5175', 'http://localhost:5175'],
});

const codegen = Codegen({ packages: [vault] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5170,
	// Pin the dev-server behind seal's acquire so the seal-aware browser
	// client can issue SessionKey calls immediately on page load.
	needs: [vault, seal, wallet, codegen],
});

export default devstack(publisher, alice, bob, walrus, seal, vault, wallet, codegen, dev, {
	// Project the Seal key server's id + URL into the manifest so the
	// frontend can wire SessionKey + SealClient against this local
	// server. Resolved as an Effect so the live values reach the
	// manifest. `SealKeyServerTag` is the narrow interface tag produced
	// by the `Seal({...})` factory above.
	extras: Effect.gen(function* () {
		const ks = yield* SealKeyServerTag;
		return {
			sealKeyServer: {
				objectId: ks.objectId,
				url: ks.keyServerUrl,
			},
		};
	}),
});
