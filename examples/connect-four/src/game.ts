// Pure connect-four game logic — no chain, no codegen, no devstack, no React.
// Decodes the on-chain Game object into a UI board, derives winning cells, and
// maps wallet addresses to seats. Unit-tested in `game.test.ts` (runs under
// `pnpm test`, boots nothing). Full-stack coverage is the Playwright suite.

export const COLS = 7;
export const ROWS = 6;
export const TOTAL_CELLS = COLS * ROWS;

const EMPTY = 0;
const PIECE_A = 1;
const PIECE_B = 2;

export type Player = 'alice' | 'bob';
export type Cell = Player | null;
export type Board = Cell[][];
export type BoardPosition = { readonly row: number; readonly col: number };
type UnknownRecord = Record<string, unknown>;

export interface ChainGame {
	readonly boardColumns: readonly (readonly number[])[];
	readonly playerA: string;
	readonly playerB: string;
	readonly turn: string;
	readonly moves: number;
	readonly winner: string | null;
}

export const emptyBoard = (): Board =>
	Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));

export function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sameAddress(
	left: string | undefined | null,
	right: string | undefined | null,
): boolean {
	return (
		left !== undefined &&
		left !== null &&
		right !== undefined &&
		right !== null &&
		left.toLowerCase() === right.toLowerCase()
	);
}

/**
 * Map an address to a connect-four seat using the on-chain Game (the two player
 * addresses live in the Game object). Returns null for an unknown/absent address.
 */
export function playerForGameAddress(
	game: ChainGame,
	address: string | null | undefined,
): Player | null {
	if (address === null || address === undefined) return null;
	if (sameAddress(address, game.playerA)) return 'alice';
	if (sameAddress(address, game.playerB)) return 'bob';
	return null;
}

/** Before a Game exists there is no on-chain identity yet, so this returns null. */
export function playerForConnectedAddress(
	game: ChainGame | null,
	address: string | undefined,
): Player | null {
	if (game === null) return null;
	return playerForGameAddress(game, address);
}

export function shortAddress(address: string): string {
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

export function readWinner(value: unknown): string | null {
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

export function decodeGame(json: unknown): ChainGame {
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

/**
 * Convert the on-chain column-major board (each column bottom-up) into the
 * row-major, top-down board the UI renders. The on-chain row 0 is the bottom
 * of the column, so UI row = ROWS - 1 - chainRow.
 */
export function boardFromChain(columns: readonly (readonly number[])[]): Board {
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

/** Scan the board for four-in-a-row by `player`, returning the winning cells. */
export function findWinningCells(
	board: Board,
	player: Player,
): ReadonlyArray<BoardPosition> | null {
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

export function isWinningCell(
	cells: ReadonlyArray<BoardPosition>,
	row: number,
	col: number,
): boolean {
	return cells.some((cell) => cell.row === row && cell.col === col);
}

export function slotClass(cell: Cell, isWinning: boolean): string {
	return ['slot', cell ?? '', isWinning ? 'winning' : ''].filter(Boolean).join(' ');
}
