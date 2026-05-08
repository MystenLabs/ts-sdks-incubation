// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects (column-major 7x6 board,
// winner: Option<address>). The Move package + openLobby seed live in
// the app's `use:` below; named accounts are declared at the top
// level so the devstack resolver materializes a `Signer` per name and
// the sui plugin's accounts action faucets each on localnet.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Transaction } from '@mysten/sui/transactions';

import {
	accounts,
	codegen,
	defineDevstackConfig,
	defineRegistryKind,
	frontend,
	publishMove,
	seed,
	sui,
	walletApp,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient } from '@mysten-incubation/devstack/helpers';

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
	use: [
		sui({ version: 'devnet-v1.71.0' }),
		accounts(),
		codegen(),
		walletApp({ port: 9421 }),
		frontend({ port: 5176 }),
		publishMove({
			name: 'connect_four',
			path: CONNECT_FOUR_DIR,
		}),
		// One-shot bootstrap: seed a single shared `Lobby` so `devstack
		// up` gives players something to join on first boot. Hash-match
		// skip is the steady-state path — once a lobby is in the
		// manifest, the input hash matches and the action is a no-op,
		// even after the lobby is joined and consumed off-chain. Lobby
		// lifecycle from there is the app's UI concern (a "Create
		// lobby" button), not the devstack cycle's: legitimate
		// consumption should not fail / re-fire setup. The cascade DOES
		// fire when it should — a republish of `connect_four` (chain
		// regenesis) flips this action's input hash through the
		// identity edge on `needs: ['connect_four']`, so a fresh chain
		// gets a fresh lobby automatically.
		seed({
			name: 'openLobby',
			needs: ['connect_four'],
			runsAs: 'alice',
			inputs: { lobby: 'openLobby' },
			run: async (ctx) => {
				const pkg = ctx.registry.packages.require('connect_four');
				// Seed as alice so the UI's "waiting (you created the lobby)"
				// surface attaches to alice on first up.
				const lobbyCreator = ctx.accounts.get('alice');
				const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
				const target = `${pkg.packageId}::game::create_lobby` as const;
				const tx = new Transaction();
				tx.moveCall({ target });
				const result = await client.signAndExecuteTransaction({
					signer: lobbyCreator,
					transaction: tx,
					options: { showObjectChanges: true, showEffects: true },
				});
				if (result.effects?.status.status !== 'success') {
					throw new Error(
						`openLobby: ${target} failed: ${result.effects?.status.error ?? 'unknown'}`,
					);
				}
				const created = (result.objectChanges ?? []).find(
					(c) =>
						c.type === 'created' && 'objectType' in c && c.objectType.endsWith('::game::Lobby'),
				);
				if (created === undefined || !('objectId' in created) || !('objectType' in created)) {
					throw new Error('openLobby: no created Lobby in objectChanges');
				}
				arenaSharedObjects(ctx.registry).register({
					name: 'openLobby',
					objectId: created.objectId,
					objectType: created.objectType,
				});
			},
		}),
	],
});
