import {
	useCurrentAccount,
	useCurrentClient,
	useCurrentNetwork,
	useDAppKit,
} from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQuery, type UseMutationResult } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Game, createLobby, joinLobby, play } from '@generated/bindings/connect_four/game.js';

import {
	COLS,
	TOTAL_CELLS,
	boardFromChain,
	decodeGame,
	emptyBoard,
	findWinningCells,
	isRecord,
	isWinningCell,
	playerForConnectedAddress,
	playerForGameAddress,
	sameAddress,
	shortAddress,
	slotClass,
	type Player,
} from './game.js';

interface ExecutedTransaction {
	readonly digest: string;
	readonly createdObjectIds: readonly string[];
}

const playerMeta: Record<Player, { readonly label: string; readonly piece: string }> = {
	alice: { label: 'Alice', piece: 'A' },
	bob: { label: 'Bob', piece: 'B' },
};

function isFailedTransaction(
	result: unknown,
): result is { FailedTransaction: { status?: { error?: unknown } } } {
	return typeof result === 'object' && result !== null && 'FailedTransaction' in result;
}

function failedTransactionMessage(result: { FailedTransaction: { status?: { error?: unknown } } }) {
	const error = result.FailedTransaction.status?.error;
	if (typeof error === 'string') return error;
	if (isRecord(error) && typeof error.message === 'string') return error.message;
	return 'transaction failed';
}

function hasTransaction(result: unknown): result is {
	Transaction: { digest: string; effects?: { changedObjects?: readonly unknown[] } };
} {
	if (typeof result !== 'object' || result === null || !('Transaction' in result)) return false;
	const tx = (result as { Transaction?: unknown }).Transaction;
	return isRecord(tx) && typeof tx.digest === 'string';
}

function hasWaitForTransaction(client: unknown): client is {
	waitForTransaction: (a: {
		readonly digest: string;
		readonly include?: { readonly effects?: boolean };
	}) => Promise<unknown>;
} {
	return (
		typeof client === 'object' &&
		client !== null &&
		'waitForTransaction' in client &&
		typeof (client as { waitForTransaction?: unknown }).waitForTransaction === 'function'
	);
}

function isCreatedObject(change: unknown): change is { readonly objectId: string } {
	if (!isRecord(change) || typeof change.objectId !== 'string') return false;
	const operation = change.idOperation;
	return (
		operation === 'Created' ||
		(isRecord(operation) && (operation.$kind === 'Created' || 'Created' in operation))
	);
}

function createdObjectIdsFrom(transaction: {
	readonly effects?: { readonly changedObjects?: readonly unknown[] };
}): readonly string[] {
	const changedObjects = transaction.effects?.changedObjects;
	if (!Array.isArray(changedObjects)) return [];
	return changedObjects.filter(isCreatedObject).map((change) => change.objectId);
}

function createdObjectIdsFromResult(result: unknown): readonly string[] {
	if (!hasTransaction(result)) return [];
	return createdObjectIdsFrom(result.Transaction);
}

function useSignAndExecute(): UseMutationResult<ExecutedTransaction, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	return useMutation<ExecutedTransaction, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if (isFailedTransaction(result)) throw new Error(failedTransactionMessage(result));
			if (!hasTransaction(result)) {
				throw new Error('signAndExecuteTransaction: missing Transaction in result');
			}
			let createdObjectIds = createdObjectIdsFrom(result.Transaction);
			if (hasWaitForTransaction(client) && result.Transaction.digest.length > 0) {
				const finalResult = await client.waitForTransaction({
					digest: result.Transaction.digest,
					include: { effects: true },
				});
				if (createdObjectIds.length === 0)
					createdObjectIds = createdObjectIdsFromResult(finalResult);
			}
			return {
				digest: result.Transaction.digest,
				createdObjectIds,
			};
		},
	});
}

export function App() {
	const account = useCurrentAccount();
	const client = useCurrentClient();
	const network = useCurrentNetwork();
	const [lobbyId, setLobbyId] = useState<string | null>(null);
	// Address that created the open lobby (player A) — the Game object that
	// records the seats does not exist until someone joins, so the lobby
	// phase remembers its creator to render the right contextual status.
	const [lobbyCreator, setLobbyCreator] = useState<string | null>(null);
	const [gameId, setGameId] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeFlow, setActiveFlow] = useState<string | null>(null);
	const { mutateAsync, isPending } = useSignAndExecute();

	const gameQuery = useQuery({
		queryKey: ['connect-four', 'game', gameId],
		queryFn: async () => {
			if (gameId === null) return null;
			const game = await Game.get({ client, objectId: gameId });
			return decodeGame(game.json);
		},
		enabled: gameId !== null,
		refetchInterval: gameId === null ? false : 1_500,
	});

	const chainGame = gameQuery.data ?? null;
	const connectedPlayer = playerForConnectedAddress(chainGame, account?.address);
	// During the lobby phase the connected account is player A iff it opened
	// the lobby. Once the Game exists, `connectedPlayer` takes over.
	const connectedIsLobbyCreator =
		gameId === null && lobbyId !== null && sameAddress(lobbyCreator, account?.address);
	const seatAddresses: Record<Player, string> = {
		alice: chainGame?.playerA ?? '',
		bob: chainGame?.playerB ?? '',
	};
	const board = useMemo(
		() => (chainGame === null ? emptyBoard() : boardFromChain(chainGame.boardColumns)),
		[chainGame],
	);
	const turn =
		chainGame === null ? 'alice' : (playerForGameAddress(chainGame, chainGame.turn) ?? 'alice');
	const winnerPlayer =
		chainGame?.winner === undefined || chainGame.winner === null
			? null
			: playerForGameAddress(chainGame, chainGame.winner);
	const winner: Player | 'draw' | null =
		winnerPlayer ?? (chainGame !== null && chainGame.moves >= TOTAL_CELLS ? 'draw' : null);
	const winningCells = useMemo(
		() => (winnerPlayer === null ? [] : (findWinningCells(board, winnerPlayer) ?? [])),
		[board, winnerPlayer],
	);
	const filledCells = chainGame?.moves ?? 0;
	const gameIsLoading = gameId !== null && (gameQuery.isLoading || chainGame === null);
	const isBusy = isPending || activeFlow !== null;
	// The connected account may move only when the game is live and it is
	// their seat's turn. Account switching is the wallet's job (the injected
	// dev wallet in DEV, a real wallet in prod), never the app's.
	const isConnectedPlayersTurn = connectedPlayer !== null && connectedPlayer === turn;
	const canMove =
		gameId !== null && !gameIsLoading && !isBusy && winner === null && isConnectedPlayersTurn;
	const ready = network !== undefined && account !== null && account !== undefined;
	// Anyone connected can open a lobby (they become player A). Once a lobby
	// exists, a different connected account joins as player B.
	const canCreateLobby = ready && lobbyId === null && gameId === null && !isBusy;
	const canJoinLobby = ready && lobbyId !== null && gameId === null && !isBusy;

	// Run a flow as the CURRENTLY CONNECTED account. The app never forces an
	// account — whoever the wallet has connected signs the transaction.
	async function runFlow(flow: string, submit: () => Promise<void>) {
		setError(null);
		setActiveFlow(flow);
		try {
			await submit();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setActiveFlow(null);
		}
	}

	async function handleCreateLobby() {
		if (!canCreateLobby) return;
		await runFlow('create-lobby', async () => {
			const tx = new Transaction();
			tx.add(createLobby());
			const result = await mutateAsync(tx);
			const createdLobbyId = result.createdObjectIds[0];
			if (createdLobbyId === undefined) {
				throw new Error('create_lobby did not return a created Lobby object');
			}
			setLobbyId(createdLobbyId);
			setLobbyCreator(account?.address ?? null);
			setLastDigest(result.digest);
		});
	}

	async function handleJoinLobby() {
		if (!canJoinLobby || lobbyId === null) return;
		await runFlow('join-lobby', async () => {
			const tx = new Transaction();
			tx.add(joinLobby({ arguments: { lobby: lobbyId } }));
			const result = await mutateAsync(tx);
			const createdGameId = result.createdObjectIds[0];
			if (createdGameId === undefined) {
				throw new Error('join_lobby did not return a created Game object');
			}
			setGameId(createdGameId);
			setLobbyId(null);
			setLobbyCreator(null);
			setLastDigest(result.digest);
		});
	}

	async function playColumn(col: number) {
		if (!canMove || gameId === null) return;
		await runFlow(`play-${col}`, async () => {
			const tx = new Transaction();
			tx.add(play({ arguments: { game: gameId, column: col } }));
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
			await gameQuery.refetch();
		});
	}

	function startNewGame() {
		setLobbyId(null);
		setLobbyCreator(null);
		setGameId(null);
		setLastDigest(null);
		setError(null);
	}

	// Contextual status from the CONNECTED account's point of view, derived
	// from its on-chain seat (`connectedPlayer`) and whose turn it is.
	const status = gameIsLoading
		? 'Loading on-chain game'
		: winner === 'draw'
			? 'Draw'
			: winner
				? connectedPlayer === winner
					? 'You connect four'
					: `${playerMeta[winner].label} connects four`
				: gameId === null && lobbyId === null
					? 'Create a lobby to start'
					: gameId === null
						? connectedIsLobbyCreator
							? 'You are Player A — waiting for an opponent'
							: 'Join the lobby as Player B'
						: isConnectedPlayersTurn
							? 'Your move'
							: connectedPlayer !== null
								? "Opponent's turn"
								: `${playerMeta[turn].label} to move`;
	const moveButtonLabel =
		activeFlow?.startsWith('play-') === true
			? 'Submitting move...'
			: isConnectedPlayersTurn
				? 'Your move — drop a piece'
				: "Opponent's turn";
	const gamePhase = gameId !== null ? 'playing' : lobbyId !== null ? 'joining' : 'opening';
	const aliceStatus =
		winner === 'alice'
			? 'Winner'
			: winner === 'draw'
				? 'Draw'
				: gameId !== null
					? turn === 'alice'
						? 'Turn'
						: 'Waiting'
					: lobbyId !== null
						? 'Lobby open'
						: 'Opens lobby';
	const bobStatus =
		winner === 'bob'
			? 'Winner'
			: winner === 'draw'
				? 'Draw'
				: gameId !== null
					? turn === 'bob'
						? 'Turn'
						: 'Waiting'
					: lobbyId !== null
						? 'Joins lobby'
						: 'Waiting';

	return (
		<div className="app-shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">Devstack connect four</p>
					<h1>Connect Four</h1>
				</div>
				<ConnectButton />
			</header>

			<main className="connect-four-grid">
				<section className="game-panel" aria-label="Connect Four board">
					<div className="board-toolbar">
						<div>
							<p className="status" aria-live="polite">
								{status}
							</p>
							<p className="meta">{filledCells}/42 on-chain moves</p>
						</div>
						<button type="button" className="ghost-button" onClick={startNewGame} disabled={isBusy}>
							New game
						</button>
					</div>

					<div className="match-flow" aria-label="Match setup">
						<div className="flow-steps" aria-label="Game phase">
							<span className={gamePhase === 'opening' ? 'active' : ''}>1 Open</span>
							<span className={gamePhase === 'joining' ? 'active' : ''}>2 Join</span>
							<span className={gamePhase === 'playing' ? 'active' : ''}>3 Play</span>
						</div>

						<div className="player-seats">
							<PlayerSeat
								name="alice"
								status={aliceStatus}
								address={seatAddresses.alice}
								current={connectedPlayer === 'alice' || connectedIsLobbyCreator}
								active={gameId !== null && winner === null && turn === 'alice'}
								complete={lobbyId !== null || gameId !== null}
								actionLabel={
									lobbyId === null && gameId === null
										? activeFlow === 'create-lobby'
											? 'Creating...'
											: 'Create Lobby'
										: undefined
								}
								disabled={!canCreateLobby}
								onAction={handleCreateLobby}
							/>
							<PlayerSeat
								name="bob"
								status={bobStatus}
								address={seatAddresses.bob}
								current={connectedPlayer === 'bob'}
								active={gameId !== null && winner === null && turn === 'bob'}
								complete={gameId !== null}
								actionLabel={
									lobbyId !== null && gameId === null
										? activeFlow === 'join-lobby'
											? 'Joining...'
											: 'Join Lobby'
										: undefined
								}
								disabled={!canJoinLobby}
								onAction={handleJoinLobby}
							/>
						</div>
					</div>

					{winner !== null && (
						<div className={`result-strip ${winner}`} role="status" aria-live="polite">
							<span className="result-token">
								{winner === 'draw' ? filledCells : playerMeta[winner].piece}
							</span>
							<div>
								<p className="result-title">
									{winner === 'draw' ? 'Draw game' : `${playerMeta[winner].label} connects four`}
								</p>
								<p className="result-copy">
									{winner === 'draw' ? 'Every column is full.' : 'Four in a row.'}
								</p>
							</div>
						</div>
					)}

					{gameId !== null && winner === null && (
						<div className="move-banner" aria-live="polite">
							<span className={`piece-dot ${turn}`} />
							<span>{moveButtonLabel}</span>
						</div>
					)}

					<div className="column-buttons" aria-label="Column selectors">
						{Array.from({ length: COLS }, (_, col) => (
							<button
								key={col}
								type="button"
								disabled={!canMove || board[0]![col] !== null}
								onClick={() => void playColumn(col)}
								aria-label={`Play column ${col + 1}`}
							>
								{col + 1}
							</button>
						))}
					</div>

					<div className={`board ${winner === null ? '' : 'settled'}`}>
						{board.map((row, rowIndex) =>
							row.map((cell, colIndex) => (
								<span
									key={`${rowIndex}-${colIndex}`}
									className={slotClass(
										cell,
										cell !== null && isWinningCell(winningCells, rowIndex, colIndex),
									)}
									aria-label={
										cell === null
											? 'empty'
											: `${playerMeta[cell].label} ${
													isWinningCell(winningCells, rowIndex, colIndex) ? 'winning ' : ''
												}piece at row ${rowIndex + 1}, column ${colIndex + 1}`
									}
								>
									{cell === null ? '' : playerMeta[cell].piece}
								</span>
							)),
						)}
					</div>
				</section>

				<aside className="side-panel">
					<div className="connect-card">
						<p className="section-label">Current signer</p>
						{account ? (
							<div className="account-line">
								<span>{connectedPlayer ? playerMeta[connectedPlayer].label : 'Signed in'}</span>
								<code>{shortAddress(account.address)}</code>
							</div>
						) : (
							<ConnectButton />
						)}
					</div>

					<div className="chain-card">
						<p className="section-label">Chain</p>
						{lobbyId !== null && <ObjectLine label="Lobby" value={lobbyId} />}
						{gameId !== null && <ObjectLine label="Game" value={gameId} />}
						{lastDigest && <p className="digest">tx {lastDigest}</p>}
						{gameQuery.error instanceof Error && <p className="error">{gameQuery.error.message}</p>}
						{error && <p className="error">{error}</p>}
					</div>
				</aside>
			</main>
		</div>
	);
}

function ObjectLine({ label, value }: { readonly label: string; readonly value: string }) {
	if (value.length === 0) return null;
	return (
		<div className="object-line">
			<span>{label}</span>
			<code>{shortAddress(value)}</code>
		</div>
	);
}

function PlayerSeat({
	name,
	address,
	status,
	current,
	active,
	complete,
	actionLabel,
	disabled = false,
	onAction,
}: {
	readonly name: Player;
	readonly address: string;
	readonly status: string;
	readonly current: boolean;
	readonly active: boolean;
	readonly complete: boolean;
	readonly actionLabel?: string;
	readonly disabled?: boolean;
	readonly onAction?: () => void;
}) {
	return (
		<div
			className={[
				'player-seat',
				name,
				active ? 'active' : '',
				complete ? 'complete' : '',
				current ? 'current' : '',
			]
				.filter(Boolean)
				.join(' ')}
		>
			<div className="seat-main">
				<span className={`piece-token ${name}`}>{playerMeta[name].piece}</span>
				<div>
					<div className="seat-title-row">
						<strong>{playerMeta[name].label}</strong>
						{current && <span className="signer-pill">selected</span>}
					</div>
					<code>{address.length > 0 ? shortAddress(address) : 'pending'}</code>
				</div>
			</div>
			<div className="seat-footer">
				<span>{status}</span>
				{actionLabel !== undefined && (
					<button
						type="button"
						className="seat-action"
						disabled={disabled}
						onClick={() => void onAction?.()}
					>
						{actionLabel}
					</button>
				)}
			</div>
		</div>
	);
}
