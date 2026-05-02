import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { deployment } from '../generated/deployment.js';
import { Game as GameStruct, Lobby as LobbyStruct } from '../generated/sui/connect_four/game.js';

export interface UseSignAndExecuteOptions {
	/** Query keys to invalidate on a successful tx. */
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

/**
 * App-local sign+execute helper. Wraps `dAppKit.signAndExecuteTransaction`
 * (the documented dapp-kit-react entry) with `useMutation` ergonomics +
 * a `waitForTransaction` step so React Query invalidations fire after
 * the indexer has the new state.
 *
 * Used to live in `@mysten-incubation/devstack/react` as
 * `useDevstackSignAndExecute` but that wasn't localnet-specific — it
 * was generic dapp-kit-react usage. App-local copy keeps prod and
 * local code structurally identical.
 */
export function useSignAndExecute(
	options: UseSignAndExecuteOptions = {},
): UseMutationResult<{ digest: string }, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const qc = useQueryClient();
	return useMutation<{ digest: string }, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if ('FailedTransaction' in result && result.FailedTransaction) {
				const status = (result.FailedTransaction as { status?: { error?: string | null } }).status;
				throw new Error(status?.error ?? 'transaction failed');
			}
			const tx = (result as { Transaction?: { digest: string } }).Transaction;
			if (!tx) throw new Error('signAndExecuteTransaction: missing Transaction in result');
			return tx;
		},
		onSuccess: async (tx) => {
			// Method-call form preserves `this` so the SDK's internal
			// `this.core.X` access works. Destructuring `client.waitForTransaction`
			// to a local would lose `this` and trip a runtime TypeError.
			const c = client as { waitForTransaction?: (a: { digest: string }) => Promise<unknown> };
			if (typeof c.waitForTransaction === 'function' && tx.digest.length > 0) {
				await c.waitForTransaction({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}

// Reused for queries the gRPC client doesn't cover (queryTransactionBlocks,
// queryEvents). FRICTION: dapp-kit's createClient picks one transport for
// all reads — we need both gRPC (for getObject + tx submit) and JSON-RPC
// (for the tx-history lookup), so we instantiate a parallel client here.
const jsonRpcClient = new SuiJsonRpcClient({ url: deployment.rpcUrl, network: 'localnet' });

export interface ArenaLobby {
	id: string;
	creator: string;
}

export interface ArenaGame {
	id: string;
	board: number[][]; // [col][row]
	playerA: string;
	playerB: string;
	turn: string;
	moves: number;
	winner: string | null;
}

export const COLS = 7;
export const ROWS = 6;

/**
 * Fetch the seeded open Lobby. Returns null when no Lobby is seeded
 * yet (pre-deploy) or when the Lobby has been consumed (joined).
 */
export function useOpenLobby() {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['arena', 'lobby', deployment.openLobbyId],
		queryFn: async (): Promise<ArenaLobby | null> => {
			if (!deployment.openLobbyId) return null;
			try {
				const result = await client.core.getObject({
					objectId: deployment.openLobbyId,
					include: { content: true },
				});
				const parsed = LobbyStruct.parse(result.object.content);
				return { id: result.object.objectId, creator: parsed.creator };
			} catch {
				// Lobby was consumed — getObject returns NotFound.
				return null;
			}
		},
		enabled: !!deployment.openLobbyId,
		// Fast polling so the lobby/game flip happens visibly. gRPC
		// subscriptions would be the long-term path; deferred to M5.
		refetchInterval: 1500,
	});
}

/**
 * Subscribe to the Game state by id. Polls every 1.5s while the game
 * is in progress so the opponent's move shows up promptly.
 */
export function useGame(gameId: string | undefined) {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['arena', 'game', gameId],
		queryFn: async (): Promise<ArenaGame | null> => {
			if (!gameId) return null;
			const result = await client.core.getObject({
				objectId: gameId,
				include: { content: true },
			});
			const parsed = GameStruct.parse(result.object.content) as {
				board: number[][];
				player_a: string;
				player_b: string;
				turn: string;
				moves: number;
				winner: string | null;
			};
			return {
				id: gameId,
				board: parsed.board.map((col) => col.map(Number)),
				playerA: parsed.player_a,
				playerB: parsed.player_b,
				turn: parsed.turn,
				moves: Number(parsed.moves),
				winner: parsed.winner ?? null,
			};
		},
		enabled: !!gameId,
		refetchInterval: 1500,
	});
}

/**
 * After `join_lobby`, the Lobby is gone and a fresh Game has been
 * created. The lobby's `previousTransaction` digest is the join_lobby
 * tx — we look up that tx's `objectChanges` for the Game's id.
 *
 * Caller passes in `lobbyId` (the consumed lobby's object id) to
 * resolve the spawned game id once after the join. The result is
 * cached under React Query so subsequent renders avoid the lookup.
 */
export function useSpawnedGame(lobbyId: string | undefined) {
	return useQuery({
		queryKey: ['arena', 'spawned-game', lobbyId],
		queryFn: async (): Promise<{ gameId: string } | null> => {
			if (!lobbyId || !deployment.connectFourPackageId) return null;
			// Find the join_lobby tx and pull the Game's id out of its
			// `objectChanges`. Filter is `InputObject` (not
			// `ChangedObject`): localnet's tx index doesn't classify
			// deletions as "changes", so once the lobby is consumed
			// only its creation tx matches `ChangedObject`.
			// `InputObject` matches any tx that passed the object in.
			const txs = await jsonRpcClient.queryTransactionBlocks({
				filter: { InputObject: lobbyId },
				options: { showObjectChanges: true },
				limit: 5,
				order: 'descending',
			});
			for (const tx of txs.data) {
				for (const change of tx.objectChanges ?? []) {
					if (
						change.type === 'created' &&
						'objectType' in change &&
						change.objectType.endsWith('::game::Game')
					) {
						return { gameId: change.objectId };
					}
				}
			}
			return null;
		},
		enabled: !!lobbyId && !!deployment.connectFourPackageId,
		refetchInterval: 1500,
	});
}
