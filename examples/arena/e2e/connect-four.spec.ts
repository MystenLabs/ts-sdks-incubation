import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectAs, expect, test } from '@mysten-incubation/devstack/playwright';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

/**
 * End-to-end Connect Four: alice joins (via UI), spawning the Game; then
 * alice and bob play scripted moves until alice wins horizontally on row
 * 0 (cols 0-3), with bob playing fillers in col 6. Plays are submitted
 * via the JSON-RPC SDK to keep the test fast — the UI flow is exercised
 * for the lobby→game transition and the final winner banner.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stack = process.env.DEVSTACK_STACK ?? 'test';
// v4 emits the manifest at `.devstack/manifest.json` (flat layout);
// per-account keys still live under `.devstack/stacks/<stack>/.keys/`
// because the accounts primitive scopes them per-stack on disk.
const manifestPath = join(here, '..', '.devstack', 'manifest.json');
const keysDir = join(here, '..', '.devstack', 'stacks', stack, '.keys');

interface RawManifest {
	packages: Array<{ name: string; packageId: string }>;
	accounts: Array<{ name: string; address: string }>;
	endpoints: Array<{ name: string; url: string }>;
	extras: { openLobbyId?: string };
}

interface ResolvedManifest {
	rpcUrl: string;
	accounts: Record<string, string>;
	connectFour: { packageId: string };
	openLobby: { objectId: string };
}

function loadManifest(): ResolvedManifest {
	const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest;
	const rpcUrl = raw.endpoints.find((s) => s.name === 'sui-rpc')?.url;
	if (rpcUrl === undefined) throw new Error('sui-rpc missing from manifest');
	const connectFour = raw.packages.find((p) => p.name === 'connect_four');
	if (connectFour === undefined) throw new Error('connect_four package missing from manifest');
	const openLobbyId = raw.extras.openLobbyId;
	if (openLobbyId === undefined) throw new Error('openLobbyId missing from manifest.extras');
	const openLobby = { objectId: openLobbyId };
	const accounts: Record<string, string> = Object.fromEntries(
		raw.accounts.map((a) => [a.name, a.address]),
	);
	return { rpcUrl, accounts, connectFour, openLobby };
}

function loadKey(name: string): Ed25519Keypair {
	const secret = readFileSync(join(keysDir, `${name}.key`), 'utf8').trim();
	return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}

test('alice + bob play to a horizontal win on row 0', async ({ page }) => {
	const manifest = loadManifest();
	const pkg = manifest.connectFour;

	// --- alice: open the lobby (via UI) ---
	await connectAs(page, 'alice');
	// The seeded lobby has alice as creator; she sees the waiting state.
	await expect(page.getByTestId('waiting')).toBeVisible({ timeout: 15_000 });

	// --- bob: join via UI ---
	await page.goto('/');
	await page.evaluate(() => localStorage.clear());
	await connectAs(page, 'bob');
	await page.getByTestId('join-lobby').click();
	// After join, the game spawns; status header surfaces "alice thinking".
	await expect(page.getByTestId('game-status')).toBeVisible({ timeout: 30_000 });

	// Resolve the spawned game id from on-chain state. The lobby is now
	// gone; queryTransactionBlocks finds the join_lobby tx and pulls the
	// Game's id out of objectChanges.
	const aliceKp = loadKey('alice');
	const bobKp = loadKey('bob');
	const rpc = new SuiJsonRpcClient({ url: manifest.rpcUrl, network: 'localnet' });
	const lobbyId = manifest.openLobby.objectId;
	const txs = await rpc.queryTransactionBlocks({
		filter: { InputObject: lobbyId },
		options: { showObjectChanges: true },
		limit: 5,
		order: 'descending',
	});
	let gameId: string | undefined;
	for (const tx of txs.data) {
		for (const change of tx.objectChanges ?? []) {
			if (
				change.type === 'created' &&
				'objectType' in change &&
				change.objectType.endsWith('::game::Game')
			) {
				gameId = change.objectId;
				break;
			}
		}
		if (gameId) break;
	}
	if (!gameId) throw new Error('spawned Game not found');

	// Play to alice's horizontal win on row 0: a:0, b:6, a:1, b:6, a:2, b:6, a:3 (win).
	const moves: { signer: Ed25519Keypair; column: number }[] = [
		{ signer: aliceKp, column: 0 },
		{ signer: bobKp, column: 6 },
		{ signer: aliceKp, column: 1 },
		{ signer: bobKp, column: 6 },
		{ signer: aliceKp, column: 2 },
		{ signer: bobKp, column: 6 },
		{ signer: aliceKp, column: 3 },
	];
	for (const move of moves) {
		const tx = new Transaction();
		tx.moveCall({
			target: `${pkg.packageId}::game::play`,
			arguments: [tx.object(gameId), tx.pure.u8(move.column)],
		});
		const result = await rpc.signAndExecuteTransaction({
			signer: move.signer,
			transaction: tx,
			options: { showEffects: true },
		});
		expect(result.effects?.status.status).toBe('success');
		await rpc.waitForTransaction({ digest: result.digest });
	}

	// Bob's polling fetch should pick up the won game state — header text
	// includes "Game over — alice wins" (alice won; bob lost).
	await expect(page.getByTestId('game-status')).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('section').filter({ hasText: /Game over — alice wins/ })).toBeVisible({
		timeout: 15_000,
	});

	// Spot-check the board: cells (0..3, 0) should all be PIECE_A (1).
	for (const col of [0, 1, 2, 3]) {
		const cell = page.getByTestId(`cell-${col}-0`);
		await expect(cell).toHaveAttribute('data-cell', '1', { timeout: 5_000 });
	}
});
