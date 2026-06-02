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

import {
	Game,
	createLobby as buildCreateLobby,
	joinLobby as buildJoinLobby,
	play as buildPlay,
} from '@generated/bindings/connect_four/game.js';

const COLS = 7;
const ROWS = 6;
const TOTAL_CELLS = COLS * ROWS;
const EMPTY = 0;
const PIECE_A = 1;
const PIECE_B = 2;

type Player = 'alice' | 'bob';
type Cell = Player | null;
type Board = Cell[][];
type BoardPosition = { readonly row: number; readonly col: number };
type UnknownRecord = Record<string, unknown>;

interface ChainGame {
	readonly boardColumns: readonly (readonly number[])[];
	readonly playerA: string;
	readonly playerB: string;
	readonly turn: string;
	readonly moves: number;
	readonly winner: string | null;
}

interface ExecutedTransaction {
	readonly digest: string;
	readonly createdObjectIds: readonly string[];
}

const emptyBoard = (): Board => Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));

const playerMeta: Record<Player, { readonly label: string; readonly piece: string }> = {
	alice: { label: 'Alice', piece: 'A' },
	bob: { label: 'Bob', piece: 'B' },
};

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameAddress(left: string | undefined | null, right: string | undefined | null): boolean {
	return (
		left !== undefined &&
		left !== null &&
		right !== undefined &&
		right !== null &&
		left.toLowerCase() === right.toLowerCase()
	);
}

/**
 * Map the connected wallet address to a connect-four seat using the
 * on-chain Game (the two player addresses live in the Game object). Before
 * a Game exists there is no on-chain identity yet, so this returns null.
 */
function playerForConnectedAddress(
	game: ChainGame | null,
	address: string | undefined,
): Player | null {
	if (game === null) return null;
	return playerForGameAddress(game, address);
}

/**
 * Drive the devstack dev-wallet account switch that powers the in-app
 * "Open as Alice" / "Join as Bob" buttons. This is a DEV-only affordance:
 * the devstack Vite plugin injects + registers the dev wallet on the page
 * and wires `globalThis.__devstackDAppKit__.selectAccount`. In a production
 * build the slot is
 * absent and the currently connected wallet signs as-is.
 */
async function selectDevstackAccount(accountName: Player): Promise<void> {
	const slot = (
		globalThis as {
			__devstackDAppKit__?: { selectAccount?: (name: string) => Promise<void> };
		}
	).__devstackDAppKit__;
	if (slot?.selectAccount !== undefined) {
		await slot.selectAccount(accountName);
	}
}

function playerForGameAddress(game: ChainGame, address: string | null | undefined): Player | null {
	if (address === null || address === undefined) return null;
	if (sameAddress(address, game.playerA)) return 'alice';
	if (sameAddress(address, game.playerB)) return 'bob';
	return null;
}

function shortAddress(address: string): string {
	return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function readStringField(record: UnknownRecord, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Game object field "${key}" is not a string`);
	}
	return value;
}

function readNumberField(record: UnknownRecord, key: string): number {
	const value = record[key];
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Error(`Game object field "${key}" is not an integer`);
	}
	return value;
}

function readBoardColumns(value: unknown): readonly (readonly number[])[] {
	if (!Array.isArray(value) || value.length !== COLS) {
		throw new Error(`Game board must contain ${COLS} columns`);
	}
	return value.map((column, columnIndex) => {
		if (!Array.isArray(column) || column.length !== ROWS) {
			throw new Error(`Game board column ${columnIndex + 1} must contain ${ROWS} rows`);
		}
		return column.map((cell) => {
			if (typeof cell !== 'number' || !Number.isInteger(cell)) {
				throw new Error('Game board contains a non-integer cell');
			}
			return cell;
		});
	});
}

function readWinner(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		if (typeof value[0] === 'string') return value[0];
	}
	if (isRecord(value)) {
		if ('Some' in value) return readWinner(value.Some);
		if ('some' in value) return readWinner(value.some);
		if ('None' in value || 'none' in value) return null;
	}
	throw new Error('Game object winner field is not an Option<address>');
}

function decodeGame(json: unknown): ChainGame {
	if (!isRecord(json)) throw new Error('Game object content is not a struct');
	return {
		boardColumns: readBoardColumns(json.board),
		playerA: readStringField(json, 'player_a'),
		playerB: readStringField(json, 'player_b'),
		turn: readStringField(json, 'turn'),
		moves: readNumberField(json, 'moves'),
		winner: readWinner(json.winner),
	};
}

function boardFromChain(columns: readonly (readonly number[])[]): Board {
	const board = emptyBoard();
	for (let col = 0; col < COLS; col += 1) {
		const column = columns[col];
		for (let chainRow = 0; chainRow < ROWS; chainRow += 1) {
			const uiRow = ROWS - 1 - chainRow;
			const piece = column?.[chainRow] ?? EMPTY;
			board[uiRow]![col] = piece === PIECE_A ? 'alice' : piece === PIECE_B ? 'bob' : null;
		}
	}
	return board;
}

function findWinningCells(board: Board, player: Player): ReadonlyArray<BoardPosition> | null {
	const dirs = [
		[1, 0],
		[0, 1],
		[1, 1],
		[1, -1],
	] as const;

	for (let row = 0; row < ROWS; row += 1) {
		for (let col = 0; col < COLS; col += 1) {
			if (board[row]![col] !== player) continue;
			for (const [dc, dr] of dirs) {
				const cells: BoardPosition[] = [{ row, col }];
				for (let step = 1; step < 4; step += 1) {
					const r = row + dr * step;
					const c = col + dc * step;
					if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r]![c] !== player) break;
					cells.push({ row: r, col: c });
				}
				if (cells.length >= 4) return cells;
			}
		}
	}
	return null;
}

function isWinningCell(cells: ReadonlyArray<BoardPosition>, row: number, col: number): boolean {
	return cells.some((cell) => cell.row === row && cell.col === col);
}

function slotClass(cell: Cell, isWinning: boolean): string {
	return ['slot', cell ?? '', isWinning ? 'winning' : ''].filter(Boolean).join(' ');
}

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
	const canMove = gameId !== null && !gameIsLoading && !isBusy && winner === null;
	const ready = network !== undefined;
	const canCreateLobby = ready && lobbyId === null && gameId === null && !isBusy;
	const canJoinLobby = ready && lobbyId !== null && gameId === null && !isBusy;

	async function runAs(player: Player, flow: string, submit: () => Promise<void>) {
		setError(null);
		setActiveFlow(flow);
		try {
			await selectDevstackAccount(player);
			await submit();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setActiveFlow(null);
		}
	}

	async function createLobby() {
		if (!canCreateLobby) return;
		await runAs('alice', 'create-lobby', async () => {
			const tx = new Transaction();
			buildCreateLobby()(tx);
			const result = await mutateAsync(tx);
			const createdLobbyId = result.createdObjectIds[0];
			if (createdLobbyId === undefined) {
				throw new Error('create_lobby did not return a created Lobby object');
			}
			setLobbyId(createdLobbyId);
			setLastDigest(result.digest);
		});
	}

	async function joinLobby() {
		if (!canJoinLobby || lobbyId === null) return;
		await runAs('bob', 'join-lobby', async () => {
			const tx = new Transaction();
			buildJoinLobby({ arguments: { lobby: lobbyId } })(tx);
			const result = await mutateAsync(tx);
			const createdGameId = result.createdObjectIds[0];
			if (createdGameId === undefined) {
				throw new Error('join_lobby did not return a created Game object');
			}
			setGameId(createdGameId);
			setLobbyId(null);
			setLastDigest(result.digest);
		});
	}

	async function playColumn(col: number) {
		if (!canMove || gameId === null) return;
		await runAs(turn, `play-${col}`, async () => {
			const tx = new Transaction();
			buildPlay({ arguments: { game: gameId, column: col } })(tx);
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
			await gameQuery.refetch();
		});
	}

	function startNewGame() {
		setLobbyId(null);
		setGameId(null);
		setLastDigest(null);
		setError(null);
	}

	const status = gameIsLoading
		? 'Loading on-chain game'
		: winner === 'draw'
			? 'Draw'
			: winner
				? `${playerMeta[winner].label} connects four`
				: gameId === null && lobbyId === null
					? 'Open the table'
					: gameId === null
						? 'Seat Bob'
						: `${playerMeta[turn].label} to move`;
	const moveButtonLabel =
		activeFlow?.startsWith('play-') === true
			? 'Submitting move...'
			: `Drop as ${playerMeta[turn].label}`;
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
								current={connectedPlayer === 'alice'}
								active={gameId !== null && winner === null && turn === 'alice'}
								complete={lobbyId !== null || gameId !== null}
								actionLabel={
									lobbyId === null && gameId === null
										? activeFlow === 'create-lobby'
											? 'Opening...'
											: 'Open as Alice'
										: undefined
								}
								disabled={!canCreateLobby}
								onAction={createLobby}
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
											: 'Join as Bob'
										: undefined
								}
								disabled={!canJoinLobby}
								onAction={joinLobby}
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
								aria-label={`Drop ${playerMeta[turn].label} piece in column ${col + 1}`}
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
