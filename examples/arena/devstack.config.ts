// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects (column-major 7x6 board,
// winner: Option<address>). The Move package + openLobby seed live in
// the app's `setup:` below; named accounts are declared at the top
// level so the devstack resolver materializes a `Signer` per name and
// the sui plugin's accounts action faucets each on localnet.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	codegen,
	defineDevstackConfig,
	defineRegistryKind,
	frontend,
	publishMove,
	seed,
	sui,
	verify,
	walletServer,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient, seedSharedObject } from '@mysten-incubation/devstack/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECT_FOUR_DIR = resolve(HERE, 'move/connect_four');

interface ArenaSharedObject {
	name: string;
	objectId: string;
	objectType: string;
}

// Typed accessor for `registry.ns('arena').sharedObjects` — single
// source of truth for the kind name + element type.
const arenaSharedObjects = defineRegistryKind<ArenaSharedObject>('arena.sharedObjects');

export default defineDevstackConfig({
	app: 'arena',
	accounts: ['publisher', 'alice', 'bob'],
	plugins: [
		sui({ version: 'devnet-v1.71.0' }),
		accounts(),
		codegen(),
		walletServer({ port: 9421 }),
		frontend({ port: 5176 }),
	],
	setup: [
		publishMove({
			name: 'connect_four',
			needs: ['accounts.fund'],
			path: CONNECT_FOUR_DIR,
		}),
		// Seed one shared `Lobby` so a fresh `devstack up` gives players
		// something to join immediately. Hash-match skip handles the
		// "already seeded, nothing changed" case via persisted state in
		// the manifest. The paired `verify()` below independently checks
		// that the seeded Lobby is still on-chain — an invariant probe,
		// not an idempotence check (the Lobby could be consumed off-chain
		// by a `join_lobby` call without any input change devstack can
		// see). On `ok: false` the verify fails the cycle loudly; the
		// user re-seeds with `devstack apply --actions arena.openLobby`.
		seed({
			name: 'openLobby',
			needs: ['connect_four'],
			inputs: { lobby: 'openLobby' },
			run: async (ctx) => {
				const pkg = ctx.registry.packages.require('connect_four');
				// Seed as alice so the UI's "waiting (you created the lobby)"
				// surface attaches to alice on first up.
				const lobbyCreator = ctx.accounts.get('alice');
				const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
				const result = await seedSharedObject({
					client,
					publisher: lobbyCreator,
					target: `${pkg.packageId}::game::create_lobby`,
					objectTypeFilter: '::game::Lobby',
				});
				arenaSharedObjects(ctx.registry).register({
					name: 'openLobby',
					objectId: result.objectId,
					objectType: result.objectType,
				});
			},
		}),
		// Invariant: the seeded Lobby exists on-chain with the expected
		// type. Verify runs every cycle — failures here mean someone
		// consumed the Lobby off-chain (a `join_lobby` call) and a
		// re-seed is needed.
		verify({
			name: 'openLobbyAlive',
			needs: ['openLobby'],
			check: async (ctx) => {
				const pkg = ctx.registry.packages.find('connect_four');
				if (pkg === undefined) return { ok: false, detail: 'connect_four not published' };
				const cached = arenaSharedObjects(ctx.registry).find('openLobby');
				if (cached === undefined) return { ok: false, detail: 'no cached lobby' };
				const expectedType = `${pkg.packageId}::game::Lobby`;
				if (cached.objectType !== expectedType) {
					return { ok: false, detail: 'lobby type stale (republished?)' };
				}
				const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
				const live = await client.getObject({ id: cached.objectId });
				if (live.data === null || live.data === undefined) {
					return { ok: false, detail: `lobby ${cached.objectId} not on chain` };
				}
				return { ok: true, detail: cached.objectId };
			},
		}),
	],
});
