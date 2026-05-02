// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects (column-major 7x6 board,
// winner: Option<address>). The Move package + openLobby seed live in
// the app's `setup:` below; named accounts are declared at the top
// level so the devstack resolver materializes a `Signer` per name and
// the sui plugin's accounts action faucets each on localnet.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type Registry,
	type RegistryQuery,
	codegen,
	defineDevstackConfig,
	frontend,
	publishMove,
	seed,
	sui,
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

const arenaSharedObjects = (registry: Registry): RegistryQuery<ArenaSharedObject> =>
	registry.ns<{ sharedObjects: RegistryQuery<ArenaSharedObject> }>('arena').sharedObjects;

export default defineDevstackConfig({
	app: 'arena',
	accounts: {
		publisher: {},
		alice: {},
		bob: {},
	},
	plugins: [
		sui({ version: 'devnet-v1.71.0' }),
		codegen(),
		walletServer({ port: 9421 }),
		frontend({ port: 5176 }),
	],
	setup: [
		publishMove({
			name: 'connect_four',
			needs: ['sui.accounts'],
			path: CONNECT_FOUR_DIR,
		}),
		// Seed one shared `Lobby` so a fresh `devstack up` gives players
		// something to join immediately. Idempotent: getStatus reuses the
		// cached objectId when its objectType matches the current
		// connect_four packageId AND the on-chain object still exists.
		// Registered under the plugin-namespaced kind
		// `arena.sharedObjects` (generic enough to extend with future
		// arena-owned shared objects without touching core kinds).
		//
		// Custom getStatus rather than runTransaction's marker file
		// because the Lobby's existence + type are on-chain state worth
		// validating directly (chain reset → marker stale; chain object
		// existence check is the truth).
		seed({
			name: 'openLobby',
			needs: ['connect_four'],
			inputs: { lobby: 'openLobby' },
			getStatus: async (ctx) => {
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
	],
});
