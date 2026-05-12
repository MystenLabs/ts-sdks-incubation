// Arena app — on-chain Connect Four. Matchmaking via shared `Lobby`
// objects, gameplay via shared `Game` objects. The Move package +
// openLobby seed live in `stack` below; the Lobby objectId surfaces
// through the manifest's `extras` slot so the UI auto-discovers a
// pre-created lobby on first boot.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { defineDevstackConfig, define, dep } from '@mysten-incubation/devstack-next';
import {
	publishMove,
	publishViaSuiCli,
	viteDevServer,
} from '@mysten-incubation/devstack-next/helpers';
import {
	accounts,
	manifest,
	sui,
	walletApp,
} from '@mysten-incubation/devstack-next/plugins';
import type { Package } from '@mysten-incubation/devstack-next/shapes';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECT_FOUR_DIR = resolve(HERE, 'move/connect_four');

const a = accounts({ specs: { publisher: {}, alice: {}, bob: {} } });

const connectFourPublish = publishMove({
	name: 'connect_four',
	path: CONNECT_FOUR_DIR,
	signer: a.pool.get('signer', { name: 'publisher' }),
	publish: publishViaSuiCli,
});

interface OpenLobbyState {
	objectId: string;
	objectType: string;
}

// One-shot bootstrap: seed a single shared `Lobby` so `pnpm dev`
// gives players something to join on first boot. Hash-match skip is
// the steady state — once the Lobby is captured, subsequent cycles
// see the same input hash and don't re-fire even after the lobby is
// consumed off-chain. Cascade fires only when `connect_four`'s
// packageId flips (chain regenesis).
const openLobby = define<OpenLobbyState>({
	name: 'arena.openLobby',
	runsAs: 'alice',
	provides: {
		objectId: dep((s: OpenLobbyState) => s.objectId),
		full: dep((s: OpenLobbyState) => s),
	},
	deps: {
		signer: a.pool.get('signer', { name: 'alice' }),
		rpc: sui.get('rpc'),
		pkg: connectFourPublish.get('package'),
	},
	inputs: ({ deps }) => {
		const d = deps as { pkg: Package };
		return { packageId: d.pkg.packageId };
	},
	start: async ({ deps }) => {
		const d = deps as {
			signer: Ed25519Keypair;
			rpc: { url: string };
			pkg: Package;
		};
		const client = new SuiJsonRpcClient({ url: d.rpc.url, network: 'localnet' });
		const tx = new Transaction();
		tx.moveCall({ target: `${d.pkg.packageId}::game::create_lobby` });
		const result = await client.signAndExecuteTransaction({
			signer: d.signer,
			transaction: tx,
			options: { showObjectChanges: true, showEffects: true },
		});
		if (result.effects?.status?.status !== 'success') {
			throw new Error(`openLobby: ${result.effects?.status?.error ?? 'unknown'}`);
		}
		const created = (result.objectChanges ?? []).find(
			(c) =>
				c.type === 'created' &&
				'objectType' in c &&
				typeof c.objectType === 'string' &&
				c.objectType.endsWith('::game::Lobby'),
		);
		if (created === undefined || created.type !== 'created') {
			throw new Error('openLobby: no created Lobby in objectChanges');
		}
		await client.waitForTransaction({ digest: result.digest });
		return {
			objectId: created.objectId,
			objectType: 'objectType' in created && typeof created.objectType === 'string'
				? created.objectType
				: '',
		};
	},
});

const wallet = walletApp.create({
	accounts: [
		{ name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
		{ name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
		{ name: 'publisher', signer: a.pool.get('signer', { name: 'publisher' }) },
	],
	allowedOrigins: ['http://localhost:5176'],
});

const m = manifest({
	packages: [connectFourPublish.get('package')],
	endpoints: [sui.get('endpoint'), sui.get('faucetEndpoint'), wallet.get('endpoint')],
	accounts: [
		a.pool.get('account', { name: 'publisher' }),
		a.pool.get('account', { name: 'alice' }),
		a.pool.get('account', { name: 'bob' }),
	],
	extras: {
		openLobbyId: openLobby.get('objectId'),
	},
});

const dev = viteDevServer({
	port: 5176,
	gates: [connectFourPublish.get('package'), openLobby.get('objectId'), wallet.get('full')],
});

export default defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }),
		a.pool,
		a.fund,
		connectFourPublish,
		openLobby,
		m,
		wallet,
		dev,
	],
});
