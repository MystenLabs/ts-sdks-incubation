module connect_four::game;

const COLS: u8 = 7;
const ROWS: u8 = 6;
const TOTAL_CELLS: u8 = 42; // COLS * ROWS

const EMPTY: u8 = 0;
const PIECE_A: u8 = 1;
const PIECE_B: u8 = 2;

const ENotYourTurn: u64 = 1;
const EColumnFull: u64 = 2;
const EGameOver: u64 = 3;
const EColumnOutOfBounds: u64 = 4;
const ESelfPlay: u64 = 5;

/// Pre-game match-making slot. Created by `create_lobby`, consumed by
/// `join_lobby` (which spawns the actual `Game`). One-shot to keep
/// matchmaking simple — the lobby disappears as soon as someone joins.
public struct Lobby has key {
	id: UID,
	/// Address that opened the lobby. Becomes player_a (moves first).
	creator: address,
}

/// Shared game state for a Connect Four match between two players.
/// `board` is column-major: `board[col][row]` for `0 <= col < COLS` and
/// `0 <= row < ROWS`. Row 0 is the bottom; pieces stack upward. Each
/// cell is `EMPTY` / `PIECE_A` / `PIECE_B`.
public struct Game has key {
	id: UID,
	board: vector<vector<u8>>,
	player_a: address,
	player_b: address,
	/// Whose move it is. Starts as player_a; flips after each `play`.
	turn: address,
	/// Number of pieces dropped so far (0..=42). Distinguishes draw
	/// (winner.is_none() && moves == 42) from in-progress.
	moves: u8,
	/// `Some(addr)` when the player at `addr` has won; `None` otherwise.
	winner: Option<address>,
}

/// Open a lobby. Anyone can `join_lobby` to start a game with the creator.
entry fun create_lobby(ctx: &mut TxContext) {
	let lobby = Lobby { id: object::new(ctx), creator: ctx.sender() };
	transfer::share_object(lobby);
}

/// Consume the lobby, spawn a fresh shared `Game` with the joiner as
/// player_b. Asserts the joiner is not the creator (no self-play).
entry fun join_lobby(lobby: Lobby, ctx: &mut TxContext) {
	let Lobby { id, creator } = lobby;
	assert!(ctx.sender() != creator, ESelfPlay);
	id.delete();
	let game = Game {
		id: object::new(ctx),
		board: empty_board(),
		player_a: creator,
		player_b: ctx.sender(),
		turn: creator,
		moves: 0,
		winner: option::none(),
	};
	transfer::share_object(game);
}

/// Drop a piece into `column` (0..COLS). Aborts if it's not the
/// caller's turn, the column is full or out of bounds, or the game is
/// over. Updates `winner` if the new piece completes a line of 4;
/// otherwise flips `turn` to the other player.
entry fun play(game: &mut Game, column: u8, ctx: &TxContext) {
	assert!(game.winner.is_none(), EGameOver);
	assert!(game.moves < TOTAL_CELLS, EGameOver);
	let player = ctx.sender();
	assert!(player == game.turn, ENotYourTurn);
	assert!(column < COLS, EColumnOutOfBounds);

	let piece = if (player == game.player_a) PIECE_A else PIECE_B;
	let row = drop_piece(&mut game.board, column, piece);
	game.moves = game.moves + 1;

	if (check_win(&game.board, column, row, piece)) {
		game.winner = option::some(player);
	} else if (game.moves < TOTAL_CELLS) {
		game.turn = if (player == game.player_a) game.player_b else game.player_a;
	};
	// Else: 42 moves, no winner = draw. winner stays None.
}

fun empty_board(): vector<vector<u8>> {
	let mut board = vector[];
	let mut c: u8 = 0;
	while (c < COLS) {
		let mut col = vector[];
		let mut r: u8 = 0;
		while (r < ROWS) {
			col.push_back(EMPTY);
			r = r + 1;
		};
		board.push_back(col);
		c = c + 1;
	};
	board
}

/// Find the first empty row in `column` and write `piece` there.
/// Returns the row index. Aborts if the column is full.
fun drop_piece(board: &mut vector<vector<u8>>, column: u8, piece: u8): u8 {
	let col = &mut board[column as u64];
	let mut row: u8 = 0;
	while ((row as u64) < col.length() && col[row as u64] != EMPTY) {
		row = row + 1;
	};
	assert!((row as u64) < col.length(), EColumnFull);
	*&mut col[row as u64] = piece;
	row
}

/// Did the just-placed piece complete 4-in-a-row in any direction?
/// Sums runs in each of 4 axes (horizontal, vertical, two diagonals)
/// from the start cell — inclusive — and trips on length >= 4.
fun check_win(board: &vector<vector<u8>>, column: u8, row: u8, piece: u8): bool {
	if (line_total(board, column, row, piece, 1, 0) >= 4) return true; // —
	if (line_total(board, column, row, piece, 0, 1) >= 4) return true; // |
	if (line_total(board, column, row, piece, 1, 1) >= 4) return true; // /
	if (anti_line_total(board, column, row, piece) >= 4) return true; // \
	false
}

/// Run length along the (+dc, +dr) axis through (col, row), inclusive.
/// Both `dc` and `dr` are non-negative, so we walk forward with `+dc/+dr`
/// and backward with `-dc/-dr`. Used for —, |, / axes.
fun line_total(
	board: &vector<vector<u8>>,
	column: u8,
	row: u8,
	piece: u8,
	dc: u8,
	dr: u8,
): u8 {
	let mut total: u8 = 1;

	// Forward: (col + dc * i, row + dr * i)
	let mut c = column;
	let mut r = row;
	loop {
		c = c + dc;
		r = r + dr;
		if (c >= COLS || r >= ROWS) break;
		if (board[c as u64][r as u64] != piece) break;
		total = total + 1;
	};

	// Backward: (col - dc * i, row - dr * i)
	c = column;
	r = row;
	loop {
		if (c < dc || r < dr) break;
		c = c - dc;
		r = r - dr;
		if (board[c as u64][r as u64] != piece) break;
		total = total + 1;
	};

	total
}

/// Run length along the \ diagonal: forward (+col, -row), backward (-col, +row).
fun anti_line_total(board: &vector<vector<u8>>, column: u8, row: u8, piece: u8): u8 {
	let mut total: u8 = 1;

	// Forward (+1, -1)
	let mut c = column;
	let mut r = row;
	loop {
		c = c + 1;
		if (r < 1) break;
		r = r - 1;
		if (c >= COLS) break;
		if (board[c as u64][r as u64] != piece) break;
		total = total + 1;
	};

	// Backward (-1, +1)
	c = column;
	r = row;
	loop {
		if (c < 1) break;
		c = c - 1;
		r = r + 1;
		if (r >= ROWS) break;
		if (board[c as u64][r as u64] != piece) break;
		total = total + 1;
	};

	total
}

#[test_only]
public fun cell(game: &Game, column: u8, row: u8): u8 {
	game.board[column as u64][row as u64]
}

#[test_only]
public fun current_turn(game: &Game): address { game.turn }

#[test]
fun test_horizontal_win() {
	let mut ctx = tx_context::dummy();
	let alice = @0xa;
	let bob = @0xb;
	let mut g = Game {
		id: object::new(&mut ctx),
		board: empty_board(),
		player_a: alice,
		player_b: bob,
		turn: alice,
		moves: 0,
		winner: option::none(),
	};
	// Alice: cols 0, 1, 2, 3 (wins on 4th). Bob: col 6 in between.
	simulate(&mut g, 0); // a
	simulate(&mut g, 6); // b
	simulate(&mut g, 1); // a
	simulate(&mut g, 6); // b
	simulate(&mut g, 2); // a
	simulate(&mut g, 6); // b
	simulate(&mut g, 3); // a — wins
	assert!(g.winner.is_some(), 0);
	assert!(*g.winner.borrow() == alice, 0);
	let Game { id, .. } = g;
	id.delete();
}

#[test]
fun test_diagonal_win_via_check() {
	// Construct a board with a / diagonal of PIECE_A across (0,0), (1,1),
	// (2,2), (3,3) and verify check_win sees it from any cell on the line.
	let mut board = empty_board();
	let mut i: u8 = 0;
	while (i < 4) {
		*&mut board[i as u64][i as u64] = PIECE_A;
		i = i + 1;
	};
	assert!(line_total(&board, 0, 0, PIECE_A, 1, 1) == 4, 0);
	assert!(line_total(&board, 3, 3, PIECE_A, 1, 1) == 4, 0);
	assert!(check_win(&board, 2, 2, PIECE_A), 0);
}

#[test]
fun test_anti_diagonal_win_via_check() {
	// \ diagonal at (3,5), (4,4), (5,3), (6,2) for PIECE_B.
	let mut board = empty_board();
	*&mut board[3][5] = PIECE_B;
	*&mut board[4][4] = PIECE_B;
	*&mut board[5][3] = PIECE_B;
	*&mut board[6][2] = PIECE_B;
	assert!(anti_line_total(&board, 3, 5, PIECE_B) == 4, 0);
	assert!(check_win(&board, 5, 3, PIECE_B), 0);
}

#[test]
fun test_vertical_win() {
	let mut board = empty_board();
	*&mut board[0][0] = PIECE_A;
	*&mut board[0][1] = PIECE_A;
	*&mut board[0][2] = PIECE_A;
	*&mut board[0][3] = PIECE_A;
	assert!(check_win(&board, 0, 0, PIECE_A), 0);
	assert!(check_win(&board, 0, 3, PIECE_A), 0);
}

#[test]
fun test_no_false_win() {
	// Three in a row should not trigger a win.
	let mut board = empty_board();
	*&mut board[1][0] = PIECE_A;
	*&mut board[2][0] = PIECE_A;
	*&mut board[3][0] = PIECE_A;
	assert!(!check_win(&board, 2, 0, PIECE_A), 0);
}

#[test_only]
fun simulate(g: &mut Game, column: u8) {
	let piece = if (g.turn == g.player_a) PIECE_A else PIECE_B;
	let row = drop_piece(&mut g.board, column, piece);
	g.moves = g.moves + 1;
	if (check_win(&g.board, column, row, piece)) {
		g.winner = option::some(g.turn);
	} else if (g.moves < TOTAL_CELLS) {
		g.turn = if (g.turn == g.player_a) g.player_b else g.player_a;
	};
}
