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
	accounts,
	defineDevstack,
	hostProcess,
	manifest,
	publishMove,
	SealKeyServer,
	sealLocalKeygen,
	suiLocalnet,
	walletApp,
	walrusLocalCluster,
} from '@mysten-incubation/devstack-effect';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, 'move/vault');

const a = accounts({ publisher: {}, alice: {}, bob: {} });

const vaultPublish = publishMove({
	name: 'vault',
	path: VAULT_DIR,
	signer: a.publisher,
});

// Walrus storage committee (4 nodes) + proxy + WAL seeding for the
// publisher/alice/bob accounts. The v4 walrus primitive collapses the
// v3 multi-tag composite into a single tag whose body acquires nodes,
// proxy, and seed-wal in order.
const w = walrusLocalCluster({
	nodeCount: 4,
	seedAccounts: [a.publisher, a.alice, a.bob],
});

// Single Seal key server in Open mode. publisher pays the on-chain
// registration tx; the keypair + KeyServer object id are cached across
// runs via StateStore (regenerated only on chain regenesis).
const sl = sealLocalKeygen({
	signer: a.publisher,
});

const wallet = walletApp({
	accounts: [a.alice, a.bob, a.publisher],
	// Allow both the router-fronted dev hostname (the URL the user
	// types in the browser) and the legacy `http://localhost:5175`
	// (back-compat for any direct-port consumers).
	allowedOrigins: ['http://dev.private-content.localhost:5175', 'http://localhost:5175'],
});

// Vite spawns on a local port (5175) and the supervisor publishes a
// Traefik file-provider entry pointing the router at it. Public
// browser URL → `http://dev.private-content.localhost:5175` (main
// stack); ready probe targets the local port directly so the
// supervisor doesn't depend on router warm-up.
const dev = hostProcess({
	name: 'frontend.dev-server',
	command: 'pnpm',
	// `port: { preferred }` allocates a per-stack host port via the
	// shared `PortAllocator` (scanning forward when a sibling stack
	// holds the preferred number) and exposes it as `$PORT` on the
	// child. The companion `vite.config.ts` reads `process.env.PORT`
	// for `server.port`. `--host 0.0.0.0` is required so traefik
	// (running inside docker) can reach vite via host.docker.internal
	// — vite defaults to 127.0.0.1. `--strictPort` so vite fails fast
	// rather than silently picking a port the supervisor doesn't
	// know about. Preferred 5170 is distinct from traefik's `vite`
	// entrypoint (5175 host) so a collision can't punt vite into a
	// dual-stack fallback that masks the readyProbe.
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort'],
	port: { preferred: 5170 },
	endpoint: { name: 'dev-server', kind: 'dev-server' },
	traefik: { service: 'dev', entrypoint: 'vite' },
	// `SealKeyServer` here pins the dev-server behind seal's acquire.
	// The interface tag is yieldable but TS treats it as a bare
	// Context.Service rather than a `PluginTag`; the cast is safe
	// because `dependsOn` only uses the yield for ordering (the engine
	// reads no fields off the tag value).
	dependsOn: [vaultPublish, SealKeyServer as never, wallet],
});

// Manifest extras: surface the Seal key server's id + URL so the
// frontend can wire SessionKey + SealClient against this localnet
// server. Resolved as an Effect so the runtime values reach the
// manifest. Pulled from the narrow `SealKeyServer` interface tag —
// `sealLocalKeygen` provides it. The seal package id is sourced from
// `manifest.packages` on the consumer side.
const m = manifest({
	extras: Effect.gen(function* () {
		const ks = yield* SealKeyServer;
		return {
			sealKeyServer: {
				objectId: ks.objectId,
				url: ks.keyServerUrl,
			},
		};
	}),
});

export default defineDevstack([
	suiLocalnet(),
	a.publisher,
	a.alice,
	a.bob,
	w,
	sl,
	vaultPublish,
	m,
	wallet,
	dev,
]);
