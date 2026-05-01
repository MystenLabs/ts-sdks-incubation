// Arena's app plugin. Owns two actions:
//
//   arena.connect_four — Publish the on-chain Connect Four package
//                        (`examples/arena/move/connect_four`). Source-digest
//                        gate (M8) skips republish when sources unchanged
//                        and the cached packageId is still live on-chain.
//   arena.openLobby    — Seed one shared `Lobby` so a fresh `devstack up`
//                        gives players something to join immediately.
//                        Idempotent: getStatus reuses the cached objectId
//                        when its objectType matches the current
//                        connect_four packageId AND the on-chain object
//                        still exists.
//
// The Lobby is registered under the plugin-namespaced kind
// `arena.sharedObjects` (Q1) — generic enough to extend with future
// arena-owned shared objects without touching the core kind set.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type Registry,
	type RegistryQuery,
	definePlugin,
	definePublishAction,
	seed,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient, seedSharedObject } from '@mysten-incubation/devstack/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECT_FOUR_DIR = resolve(HERE, 'move/connect_four');

interface ArenaSharedObject {
	name: string;
	objectId: string;
	objectType: string;
}

export const arenaPlugin = () =>
	definePlugin({
		name: 'arena',
		actions: () => [
			definePublishAction({
				name: 'connect_four',
				needs: ['sui.accounts'],
				sourcePath: CONNECT_FOUR_DIR,
			}),
			seed({
				name: 'openLobby',
				needs: ['connect_four'],
				inputs: { lobby: 'openLobby' },
				getStatus: async (ctx) => {
					const pkg = ctx.registry.packages.find('connect_four');
					if (pkg === undefined) return { ok: false, detail: 'connect_four not published' };
					const ns = arenaSharedObjects(ctx.registry);
					const cached = ns.find('openLobby');
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

function arenaSharedObjects(registry: Registry): RegistryQuery<ArenaSharedObject> {
	const ns = registry.ns<{ sharedObjects: RegistryQuery<ArenaSharedObject> }>('arena');
	return ns.sharedObjects;
}
