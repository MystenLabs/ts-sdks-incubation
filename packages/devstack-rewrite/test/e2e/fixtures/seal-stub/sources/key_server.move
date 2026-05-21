// Minimal stand-in for the Seal package's `key_server` module.
//
// The devstack-rewrite Seal local-keygen path publishes this package,
// then runs the canonical register target:
//   <published package>::key_server::create_and_transfer_v2_independent_server
//
// Keep this module structurally aligned with that SDK register path so
// e2e boots exercise real Sui publish/register plumbing while avoiding
// a full upstream Seal source checkout.

module seal_stub::key_server;

use std::string::String;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

public struct KeyServer has key, store {
	id: UID,
	name: String,
	url: String,
	key_type: u8,
	public_key: vector<u8>,
}

public entry fun create_and_transfer_v2_independent_server(
	name: String,
	url: String,
	key_type: u8,
	public_key: vector<u8>,
	ctx: &mut TxContext,
) {
	let server = KeyServer {
		id: object::new(ctx),
		name,
		url,
		key_type,
		public_key,
	};
	transfer::public_transfer(server, tx_context::sender(ctx));
}
