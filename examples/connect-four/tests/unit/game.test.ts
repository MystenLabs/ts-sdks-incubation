// Unit test — pure logic, no devstack, no Docker. Runs under `pnpm test`.

import { describe, expect, it } from 'vitest';

import {
	COLS,
	ROWS,
	boardFromChain,
	decodeGame,
	emptyBoard,
	findWinningCells,
	playerForConnectedAddress,
	playerForGameAddress,
	readWinner,
	sameAddress,
	shortAddress,
	slotClass,
	type Board,
	type ChainGame,
} from '../../src/game.js';

// Helper: build the on-chain column-major board (7 columns × 6 rows, bottom-up)
// from a list of (column, piece) drops, mirroring how the Move package stacks
// pieces. Index 0 of each column is the bottom row.
const chainBoard = (drops: ReadonlyArray<readonly [col: number, piece: number]>) => {
	const cols: number[][] = Array.from({ length: COLS }, () => Array<number>(ROWS).fill(0));
	const heights = Array<number>(COLS).fill(0);
	for (const [col, piece] of drops) {
		cols[col]![heights[col]!] = piece;
		heights[col]! += 1;
	}
	return cols;
};

const game = (overrides: Partial<ChainGame> = {}): ChainGame => ({
	boardColumns: chainBoard([]),
	playerA: '0xAAA',
	playerB: '0xBBB',
	turn: '0xAAA',
	moves: 0,
	winner: null,
	...overrides,
});

describe('sameAddress', () => {
	it('matches case-insensitively', () => {
		expect(sameAddress('0xABC', '0xabc')).toBe(true);
	});

	it('is false for null/undefined on either side', () => {
		expect(sameAddress(null, '0x1')).toBe(false);
		expect(sameAddress('0x1', undefined)).toBe(false);
		expect(sameAddress(null, null)).toBe(false);
	});
});

describe('shortAddress', () => {
	it('keeps the prefix and suffix', () => {
		expect(shortAddress('0x1234567890abcdef1234')).toEqual('0x123456...ef1234');
	});
});

describe('playerForGameAddress / playerForConnectedAddress', () => {
	const g = game();

	it('maps each seat address to its player', () => {
		expect(playerForGameAddress(g, '0xaaa')).toBe('alice');
		expect(playerForGameAddress(g, '0xBBB')).toBe('bob');
	});

	it('returns null for an unknown or absent address', () => {
		expect(playerForGameAddress(g, '0xCCC')).toBeNull();
		expect(playerForGameAddress(g, null)).toBeNull();
		expect(playerForGameAddress(g, undefined)).toBeNull();
	});

	it('returns null before a game exists', () => {
		expect(playerForConnectedAddress(null, '0xAAA')).toBeNull();
		expect(playerForConnectedAddress(g, '0xBBB')).toBe('bob');
	});
});

describe('readWinner', () => {
	it('reads a plain address', () => {
		expect(readWinner('0xWIN')).toBe('0xWIN');
	});

	it('treats null/undefined and empty/None options as no winner', () => {
		expect(readWinner(null)).toBeNull();
		expect(readWinner(undefined)).toBeNull();
		expect(readWinner([])).toBeNull();
		expect(readWinner({ None: true })).toBeNull();
	});

	it('unwraps Some/some option shapes', () => {
		expect(readWinner({ Some: '0xWIN' })).toBe('0xWIN');
		expect(readWinner({ some: ['0xWIN'] })).toBe('0xWIN');
		expect(readWinner(['0xWIN'])).toBe('0xWIN');
	});

	it('throws on an unrecognized winner shape', () => {
		expect(() => readWinner(42)).toThrow('Option<address>');
	});
});

describe('decodeGame', () => {
	it('decodes a well-formed Game object', () => {
		const json = {
			board: chainBoard([
				[0, 1],
				[1, 2],
			]),
			player_a: '0xAAA',
			player_b: '0xBBB',
			turn: '0xAAA',
			moves: 2,
			winner: null,
		};
		expect(decodeGame(json)).toEqual({
			boardColumns: json.board,
			playerA: '0xAAA',
			playerB: '0xBBB',
			turn: '0xAAA',
			moves: 2,
			winner: null,
		});
	});

	it('throws when the content is not a struct', () => {
		expect(() => decodeGame('nope')).toThrow('not a struct');
	});

	it('throws when a string field is missing or empty', () => {
		const json = {
			board: chainBoard([]),
			player_a: '',
			player_b: '0xBBB',
			turn: '0xAAA',
			moves: 0,
			winner: null,
		};
		expect(() => decodeGame(json)).toThrow('player_a');
	});

	it('throws when the board has the wrong column count', () => {
		const json = {
			board: [[0, 0, 0, 0, 0, 0]],
			player_a: '0xAAA',
			player_b: '0xBBB',
			turn: '0xAAA',
			moves: 0,
			winner: null,
		};
		expect(() => decodeGame(json)).toThrow(`${COLS} columns`);
	});

	it('throws on a non-integer move count', () => {
		const json = {
			board: chainBoard([]),
			player_a: '0xAAA',
			player_b: '0xBBB',
			turn: '0xAAA',
			moves: 1.5,
			winner: null,
		};
		expect(() => decodeGame(json)).toThrow('moves');
	});
});

describe('emptyBoard', () => {
	it('is ROWS × COLS of nulls', () => {
		const board = emptyBoard();
		expect(board).toHaveLength(ROWS);
		expect(board.every((row) => row.length === COLS && row.every((c) => c === null))).toBe(true);
	});
});

describe('boardFromChain', () => {
	it('flips chain rows (bottom-up) into UI rows (top-down)', () => {
		// Two alice pieces stacked in column 0: bottom + one above.
		const board = boardFromChain(
			chainBoard([
				[0, 1],
				[0, 1],
			]),
		);
		// Bottom of the UI board is the last row.
		expect(board[ROWS - 1]![0]).toBe('alice');
		expect(board[ROWS - 2]![0]).toBe('alice');
		expect(board[ROWS - 3]![0]).toBeNull();
	});

	it('maps piece codes to seats and empty cells to null', () => {
		const board = boardFromChain(
			chainBoard([
				[3, 1],
				[5, 2],
			]),
		);
		expect(board[ROWS - 1]![3]).toBe('alice');
		expect(board[ROWS - 1]![5]).toBe('bob');
		expect(board[0]![0]).toBeNull();
	});
});

describe('findWinningCells', () => {
	const put = (
		board: Board,
		player: 'alice' | 'bob',
		cells: ReadonlyArray<readonly [row: number, col: number]>,
	) => {
		for (const [r, c] of cells) board[r]![c] = player;
		return board;
	};

	it('finds a horizontal four-in-a-row', () => {
		const board = put(emptyBoard(), 'alice', [
			[5, 0],
			[5, 1],
			[5, 2],
			[5, 3],
		]);
		const win = findWinningCells(board, 'alice');
		expect(win).not.toBeNull();
		expect(win).toHaveLength(4);
	});

	it('finds a vertical four-in-a-row', () => {
		const board = put(emptyBoard(), 'bob', [
			[2, 4],
			[3, 4],
			[4, 4],
			[5, 4],
		]);
		expect(findWinningCells(board, 'bob')).toHaveLength(4);
	});

	it('finds a diagonal four-in-a-row', () => {
		const board = put(emptyBoard(), 'alice', [
			[5, 0],
			[4, 1],
			[3, 2],
			[2, 3],
		]);
		expect(findWinningCells(board, 'alice')).toHaveLength(4);
	});

	it('returns null when there is only a run of three', () => {
		const board = put(emptyBoard(), 'alice', [
			[5, 0],
			[5, 1],
			[5, 2],
		]);
		expect(findWinningCells(board, 'alice')).toBeNull();
	});

	it('returns null for an empty board', () => {
		expect(findWinningCells(emptyBoard(), 'alice')).toBeNull();
	});
});

describe('slotClass', () => {
	it('composes base, piece, and winning classes', () => {
		expect(slotClass(null, false)).toBe('slot');
		expect(slotClass('alice', false)).toBe('slot alice');
		expect(slotClass('bob', true)).toBe('slot bob winning');
	});
});
