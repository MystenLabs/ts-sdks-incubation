module greeting::board;

use sui::event;

public struct Board has key {
	id: UID,
	message_count: u64,
}

public struct Greeting has copy, drop {
	sender: address,
	message: vector<u8>,
	count: u64,
}

fun init(ctx: &mut TxContext) {
	let board = Board {
		id: object::new(ctx),
		message_count: 0,
	};
	transfer::share_object(board);
}

public fun greet(board: &mut Board, message: vector<u8>, ctx: &TxContext) {
	board.message_count = board.message_count + 1;
	event::emit(Greeting {
		sender: ctx.sender(),
		message,
		count: board.message_count,
	});
}
