import { type ArenaGame, COLS, ROWS } from '../lib/queries.js';

interface BoardProps {
	game: ArenaGame;
	self: string;
	onDrop: (column: number) => void;
	disabled?: boolean;
}

const COL_INDICES = Array.from({ length: COLS }, (_, i) => i);

/**
 * 7×6 board with one drop button per column (top row). Pieces stack
 * upward. Empty cells render as light dots; piece cells render in the
 * player's color. Top row (row index ROWS-1) is the topmost cell, but
 * we render rows in reverse so row 0 (bottom of board) appears at the
 * bottom of the grid.
 */
export function Board({ game, self, onDrop, disabled }: BoardProps) {
	const isMyTurn = game.turn === self && game.winner === null && game.moves < COLS * ROWS;
	const colorFor = (cell: number) => {
		if (cell === 1) return 'bg-rose-500'; // player_a
		if (cell === 2) return 'bg-amber-400'; // player_b
		return 'bg-neutral-200 dark:bg-neutral-700';
	};

	return (
		<div className="space-y-2" data-testid="board">
			<div className={`grid grid-cols-7 gap-1 ${isMyTurn ? '' : 'opacity-90'}`}>
				{COL_INDICES.map((col) => (
					<button
						key={col}
						type="button"
						aria-label={`drop in column ${col}`}
						data-testid={`drop-${col}`}
						disabled={disabled || !isMyTurn || isColumnFull(game.board, col)}
						onClick={() => onDrop(col)}
						className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
					>
						▼ {col}
					</button>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1 p-2 rounded-md bg-blue-100 dark:bg-blue-950/40">
				{rowsTopDown(game.board).map((row, rIdx) =>
					row.map((cell, cIdx) => {
						const realRow = ROWS - 1 - rIdx;
						return (
							<div
								key={`${cIdx}-${realRow}`}
								data-testid={`cell-${cIdx}-${realRow}`}
								data-cell={cell}
								className={`aspect-square rounded-full ${colorFor(cell)}`}
							/>
						);
					}),
				)}
			</div>
		</div>
	);
}

function isColumnFull(board: number[][], col: number): boolean {
	const column = board[col];
	if (!column) return false;
	return column[ROWS - 1] !== 0;
}

/**
 * Reshape column-major board into row-major top-to-bottom rows so the
 * grid renders the bottom of the play area at the bottom of the screen.
 */
function rowsTopDown(board: number[][]): number[][] {
	const rows: number[][] = [];
	for (let r = ROWS - 1; r >= 0; r--) {
		const row: number[] = [];
		for (let c = 0; c < COLS; c++) {
			row.push(board[c]?.[r] ?? 0);
		}
		rows.push(row);
	}
	return rows;
}
