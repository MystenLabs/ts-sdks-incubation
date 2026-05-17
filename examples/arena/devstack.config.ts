// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects. A single shared `Lobby`
// is seeded after publish so first-boot players have something to
// join; its objectId surfaces through the manifest's `extras` slot.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import {
	Account,
	Action,
	Codegen,
	Dev,
	devstack,
	Package,
	pickCreatedByTypeSuffix,
	Wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECT_FOUR_DIR = resolve(HERE, 'move/connect_four');

const publisher = Account('publisher');
const alice = Account('alice');
const bob = Account('bob');

const connectFour = Package('connect_four', CONNECT_FOUR_DIR, { signer: publisher });

const openLobby = Action('arena.openLobby', {
	signer: alice,
	needs: [connectFour],
	// Idempotent against connect_four's packageId: once a Lobby exists on
	// chain for this published package, every restart reuses its objectId
	// instead of creating a new one. Without this, each `r` / process
	// restart minted a fresh Lobby and the frontend (which reads
	// openLobbyId from the manifest) pivoted off any in-progress game.
	cacheKey: Effect.gen(function* () {
		const pkg = yield* connectFour;
		return pkg.packageId;
	}),
	build: (t) =>
		Effect.gen(function* () {
			const pkg = yield* connectFour;
			t.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});

const wallet = Wallet({
	accounts: [alice, bob, publisher],
	allowedOrigins: ['http://dev.arena.localhost:5175', 'http://localhost:5176'],
});

const codegen = Codegen({ packages: [connectFour] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5176,
	needs: [connectFour, openLobby, wallet, codegen],
});

export default devstack(publisher, alice, bob, connectFour, openLobby, wallet, codegen, dev, {
	// Disable hot-restart under playwright. Codegen + `sui move build`
	// touch files inside `move/connect_four/` during the first cycle,
	// which trips the file watcher's restart — playwright's webServer
	// then races vite's brief death against the test's first navigation
	// and intermittently sees a 502.
	hotRestart: process.env.PLAYWRIGHT === '1' ? false : undefined,
	// Surface the seeded Lobby id so the frontend can pivot a fresh
	// browser session onto an existing game without scanning chain
	// state. Resolved as an Effect so `openLobby`'s post-acquire
	// objectChanges are yielded before serialization.
	extras: Effect.gen(function* () {
		const r = yield* openLobby;
		const openLobbyId = pickCreatedByTypeSuffix(r.objectChanges, '::game::Lobby');
		return openLobbyId === undefined ? {} : { openLobbyId };
	}),
});
