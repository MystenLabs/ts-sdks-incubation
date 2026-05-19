module greeting::board;

use std::string::{Self, String};
use sui::event;

/// Shared object that holds the most recent greeting plus a monotonic
/// counter. One `Board` per stack, created by `init_board` at deploy
/// time. The fork-greeting e2e asserts `latest` round-trips after a
/// `post` call.
public struct Board has key {
	id: UID,
	/// Last greeter's address. `@0x0` until the first `post`.
	greeter: address,
	/// Last greeting's message. Empty until the first `post`.
	latest: String,
	/// Number of greetings posted since the board was created. Lets the
	/// frontend assert "my post landed" without comparing strings (the
	/// counter only goes up, so any increment is positive proof).
	count: u64,
}

/// Emitted on each `post` call. The e2e asserts the digest surfaces in
/// the UI; the chain check is implicit (no digest = no tx).
public struct Greeting has copy, drop {
	greeter: address,
	message: vector<u8>,
}

/// Module initializer — creates and shares a single `Board` so the
/// frontend has a stable shared-object id to read + write against.
/// devstack's `init_board` Action captures the resulting `Board` id
/// through `extras` so the manifest carries it.
fun init(ctx: &mut TxContext) {
	let board = Board {
		id: object::new(ctx),
		greeter: @0x0,
		latest: string::utf8(b""),
		count: 0,
	};
	transfer::share_object(board);
}

/// Write a greeting onto the shared board. Anyone may call this — it's
/// the simplest possible user-driven on-chain action, which is what
/// this fork-mode harness demos.
public fun post(board: &mut Board, message: vector<u8>, ctx: &TxContext) {
	board.greeter = ctx.sender();
	board.latest = string::utf8(message);
	board.count = board.count + 1;
	event::emit(Greeting {
		greeter: ctx.sender(),
		message,
	});
}

// --- Test-only accessors --------------------------------------------------
// View functions for off-chain reads. The frontend uses
// `client.core.getObject` directly and parses the BCS, but exposing
// these makes hand-debugging via `sui client call --function …` ergonomic.

public fun greeter(board: &Board): address { board.greeter }
public fun latest(board: &Board): &String { &board.latest }
public fun count(board: &Board): u64 { board.count }
