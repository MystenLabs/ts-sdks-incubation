module connect_four::game;

const COLS: u8 = 7;
const ROWS: u8 = 6;
const TOTAL_CELLS: u8 = 42;

const EMPTY: u8 = 0;
const PIECE_A: u8 = 1;
const PIECE_B: u8 = 2;

const ENotYourTurn: u64 = 1;
const EColumnFull: u64 = 2;
const EGameOver: u64 = 3;
const EColumnOutOfBounds: u64 = 4;
const ESelfPlay: u64 = 5;

public struct Lobby has key {
	id: UID,
	creator: address,
}

public struct Game has key {
	id: UID,
	board: vector<vector<u8>>,
	player_a: address,
	player_b: address,
	turn: address,
	moves: u8,
	winner: Option<address>,
}

entry fun create_lobby(ctx: &mut TxContext) {
	let lobby = Lobby { id: object::new(ctx), creator: ctx.sender() };
	transfer::share_object(lobby);
}

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
}

fun empty_board(): vector<vector<u8>> {
	let mut board = vector[];
	let mut column: u8 = 0;
	while (column < COLS) {
		let mut cells = vector[];
		let mut row: u8 = 0;
		while (row < ROWS) {
			cells.push_back(EMPTY);
			row = row + 1;
		};
		board.push_back(cells);
		column = column + 1;
	};
	board
}

fun drop_piece(board: &mut vector<vector<u8>>, column: u8, piece: u8): u8 {
	let cells = &mut board[column as u64];
	let mut row: u8 = 0;
	while ((row as u64) < cells.length() && cells[row as u64] != EMPTY) {
		row = row + 1;
	};
	assert!((row as u64) < cells.length(), EColumnFull);
	*&mut cells[row as u64] = piece;
	row
}

fun check_win(board: &vector<vector<u8>>, column: u8, row: u8, piece: u8): bool {
	if (line_total(board, column, row, piece, 1, 0) >= 4) return true;
	if (line_total(board, column, row, piece, 0, 1) >= 4) return true;
	if (line_total(board, column, row, piece, 1, 1) >= 4) return true;
	if (anti_line_total(board, column, row, piece) >= 4) return true;
	false
}

fun line_total(
	board: &vector<vector<u8>>,
	column: u8,
	row: u8,
	piece: u8,
	dc: u8,
	dr: u8,
): u8 {
	let mut total: u8 = 1;

	let mut c = column;
	let mut r = row;
	loop {
		c = c + dc;
		r = r + dr;
		if (c >= COLS || r >= ROWS) break;
		if (board[c as u64][r as u64] != piece) break;
		total = total + 1;
	};

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

fun anti_line_total(board: &vector<vector<u8>>, column: u8, row: u8, piece: u8): u8 {
	let mut total: u8 = 1;

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
