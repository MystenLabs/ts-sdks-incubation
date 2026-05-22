import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Transaction } from '@mysten/sui/transactions';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { accounts } from './generated/accounts.js';
import { packages } from './generated/packages.js';

const COLS = 7;
const ROWS = 6;
type Player = 'alice' | 'bob';
type Cell = Player | null;
type Board = Cell[][];

const emptyBoard = (): Board => Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));

const playerMeta: Record<Player, { readonly label: string; readonly piece: string }> = {
	alice: { label: 'Alice', piece: 'A' },
	bob: { label: 'Bob', piece: 'B' },
};

const connectFourPackageId = packages.connect_four?.packageId ?? '';

function playerForAddress(address: string | undefined): Player | null {
	if (address === undefined) return null;
	if (address === accounts.alice?.address) return 'alice';
	if (address === accounts.bob?.address) return 'bob';
	return null;
}

function shortAddress(address: string): string {
	return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function dropPiece(board: Board, col: number, player: Player): Board | null {
	const next = board.map((row) => [...row]);
	for (let row = ROWS - 1; row >= 0; row -= 1) {
		if (next[row]![col] === null) {
			next[row]![col] = player;
			return next;
		}
	}
	return null;
}

function hasWon(board: Board, player: Player): boolean {
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
				let total = 1;
				for (let step = 1; step < 4; step += 1) {
					const r = row + dr * step;
					const c = col + dc * step;
					if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r]![c] !== player) break;
					total += 1;
				}
				if (total >= 4) return true;
			}
		}
	}
	return false;
}

function isDraw(board: Board): boolean {
	return board.every((row) => row.every((cell) => cell !== null));
}

function isFailedTransaction(
	result: unknown,
): result is { FailedTransaction: { status?: { error?: string | null } } } {
	return typeof result === 'object' && result !== null && 'FailedTransaction' in result;
}

function hasTransaction(result: unknown): result is { Transaction: { digest: string } } {
	if (typeof result !== 'object' || result === null || !('Transaction' in result)) return false;
	const tx = (result as { Transaction?: unknown }).Transaction;
	return (
		typeof tx === 'object' &&
		tx !== null &&
		'digest' in tx &&
		typeof (tx as { digest?: unknown }).digest === 'string'
	);
}

function hasWaitForTransaction(
	client: unknown,
): client is { waitForTransaction: (a: { digest: string }) => Promise<unknown> } {
	return (
		typeof client === 'object' &&
		client !== null &&
		'waitForTransaction' in client &&
		typeof (client as { waitForTransaction?: unknown }).waitForTransaction === 'function'
	);
}

function useSignAndExecute(): UseMutationResult<{ digest: string }, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	return useMutation<{ digest: string }, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if (isFailedTransaction(result)) {
				throw new Error(result.FailedTransaction.status?.error ?? 'transaction failed');
			}
			if (!hasTransaction(result)) {
				throw new Error('signAndExecuteTransaction: missing Transaction in result');
			}
			return result.Transaction;
		},
		onSuccess: async (tx) => {
			if (hasWaitForTransaction(client)) await client.waitForTransaction({ digest: tx.digest });
		},
	});
}

export function App() {
	const account = useCurrentAccount();
	const connectedPlayer = playerForAddress(account?.address);
	const [board, setBoard] = useState<Board>(() => emptyBoard());
	const [turn, setTurn] = useState<Player>('alice');
	const [winner, setWinner] = useState<Player | 'draw' | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { mutateAsync, isPending } = useSignAndExecute();

	const filledCells = useMemo(() => board.flat().filter(Boolean).length, [board]);
	const canMove = connectedPlayer === turn && winner === null;

	async function createLobby() {
		setError(null);
		try {
			if (connectFourPackageId.length === 0) throw new Error('connect_four package is not ready');
			const tx = new Transaction();
			tx.moveCall({ target: `${connectFourPackageId}::game::create_lobby` });
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	function playColumn(col: number) {
		if (!canMove) return;
		const next = dropPiece(board, col, turn);
		if (next === null) return;
		setBoard(next);
		if (hasWon(next, turn)) {
			setWinner(turn);
			return;
		}
		if (isDraw(next)) {
			setWinner('draw');
			return;
		}
		setTurn(turn === 'alice' ? 'bob' : 'alice');
	}

	function reset() {
		setBoard(emptyBoard());
		setTurn('alice');
		setWinner(null);
		setError(null);
	}

	const status =
		winner === 'draw'
			? 'Draw'
			: winner
				? `${playerMeta[winner].label} wins`
				: connectedPlayer === null
					? 'Connect Alice or Bob'
					: connectedPlayer === turn
						? `${playerMeta[turn].label} to move`
						: `Switch to ${playerMeta[turn].label}`;

	return (
		<div className="app-shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">Devstack arena</p>
					<h1>Connect Four</h1>
				</div>
				<ConnectButton />
			</header>

			<main className="arena-grid">
				<section className="game-panel" aria-label="Connect Four board">
					<div className="board-toolbar">
						<div>
							<p className="status">{status}</p>
							<p className="meta">{filledCells}/42 moves</p>
						</div>
						<button type="button" className="ghost-button" onClick={reset}>
							Reset
						</button>
					</div>

					<div className="column-buttons" aria-label="Column selectors">
						{Array.from({ length: COLS }, (_, col) => (
							<button
								key={col}
								type="button"
								disabled={!canMove || board[0]![col] !== null}
								onClick={() => playColumn(col)}
								aria-label={`Drop in column ${col + 1}`}
							>
								{col + 1}
							</button>
						))}
					</div>

					<div className="board">
						{board.map((row, rowIndex) =>
							row.map((cell, colIndex) => (
								<span
									key={`${rowIndex}-${colIndex}`}
									className={`slot ${cell ?? ''}`}
									aria-label={
										cell === null
											? 'empty'
											: `${playerMeta[cell].label} piece at row ${rowIndex + 1}, column ${
													colIndex + 1
												}`
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
						<p className="section-label">Wallet</p>
						{account ? (
							<div className="account-line">
								<span>{connectedPlayer ? playerMeta[connectedPlayer].label : 'Publisher'}</span>
								<code>{shortAddress(account.address)}</code>
							</div>
						) : (
							<ConnectButton />
						)}
					</div>

					<div className="players">
						<PlayerRow name="alice" address={accounts.alice?.address ?? ''} active={turn === 'alice'} />
						<PlayerRow name="bob" address={accounts.bob?.address ?? ''} active={turn === 'bob'} />
					</div>

					<div className="chain-card">
						<p className="section-label">Lobby</p>
						<button
							type="button"
							className="primary-button"
							disabled={!account || isPending || connectFourPackageId.length === 0}
							onClick={createLobby}
						>
							{isPending ? 'Creating…' : account ? 'Create lobby on-chain' : 'Connect wallet'}
						</button>
						{connectFourPackageId.length > 0 && <code className="package-id">{connectFourPackageId}</code>}
						{lastDigest && <p className="digest">tx {lastDigest}</p>}
						{error && <p className="error">{error}</p>}
					</div>
				</aside>
			</main>
		</div>
	);
}

function PlayerRow({
	name,
	address,
	active,
}: {
	readonly name: Player;
	readonly address: string;
	readonly active: boolean;
}) {
	return (
		<div className={`player-row ${active ? 'active' : ''}`}>
			<span className={`piece-dot ${name}`} />
			<div>
				<strong>{playerMeta[name].label}</strong>
				<code>{address.length > 0 ? shortAddress(address) : 'pending'}</code>
			</div>
		</div>
	);
}
