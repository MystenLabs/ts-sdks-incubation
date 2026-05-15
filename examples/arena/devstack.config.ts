// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects. A single shared `Lobby`
// is seeded after publish so first-boot players have something to
// join; its objectId surfaces through the manifest's `extras` slot.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import {
	accounts,
	defineDevstack,
	hostProcess,
	manifest,
	pickCreatedByTypeSuffix,
	publishMove,
	suiLocalnet,
	tx,
	walletApp,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECT_FOUR_DIR = resolve(HERE, 'move/connect_four');

const a = accounts({ publisher: {}, alice: {}, bob: {} });

const connectFourPublish = publishMove({
	name: 'connect_four',
	path: CONNECT_FOUR_DIR,
	signer: a.publisher,
});

const openLobby = tx({
	name: 'arena.openLobby',
	signer: a.alice,
	dependsOn: [connectFourPublish],
	// Idempotent against connect_four's packageId: once a Lobby exists on
	// chain for this published package, every restart reuses its objectId
	// instead of creating a new one. Without this, each `r` / process
	// restart minted a fresh Lobby and the frontend (which reads
	// openLobbyId from the manifest) pivoted off any in-progress game.
	cacheKey: Effect.gen(function* () {
		const pkg = yield* connectFourPublish;
		return pkg.packageId;
	}),
	build: (t) =>
		Effect.gen(function* () {
			const pkg = yield* connectFourPublish;
			t.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});

const wallet = walletApp({
	accounts: [a.alice, a.bob, a.publisher],
	// Router-fronted dev URL on the well-known vite entrypoint port
	// (5175) + legacy direct port.
	allowedOrigins: ['http://dev.arena.localhost:5175', 'http://localhost:5176'],
});

// `port: { preferred }` allocates a per-stack host port via the
// shared `PortAllocator` and exposes it as `$PORT`. `vite.config.ts`
// reads `process.env.PORT` for `server.port`. `--host 0.0.0.0` so
// traefik (running inside docker) can reach vite via
// host.docker.internal. `--strictPort` so vite fails fast rather than
// drifting to a port the supervisor doesn't know about.
const dev = hostProcess({
	name: 'frontend.dev-server',
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort'],
	port: { preferred: 5176 },
	endpoint: { name: 'dev-server', kind: 'dev-server' },
	traefik: { service: 'dev', entrypoint: 'vite' },
	dependsOn: [connectFourPublish, openLobby, wallet],
});

// Manifest extras carry the lobby id. Resolved as an Effect so the
// openLobby tag's result (objectChanges) is yielded post-acquire.
const m = manifest({
	extras: Effect.gen(function* () {
		const r = yield* openLobby;
		const openLobbyId = pickCreatedByTypeSuffix(r.objectChanges, '::game::Lobby');
		return openLobbyId === undefined ? {} : { openLobbyId };
	}),
});

export default defineDevstack([
	suiLocalnet(),
	a.publisher,
	a.alice,
	a.bob,
	connectFourPublish,
	openLobby,
	m,
	wallet,
	dev,
]);
