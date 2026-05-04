module hello::hello;

use sui::event;

/// Emitted on each `mint` call. The e2e test asserts the digest surfaces
/// in the UI; the chain check is implicit (the tx wouldn't have a digest
/// otherwise).
public struct Greeting has copy, drop {
	greeter: address,
	message: vector<u8>,
}

/// Emit a greeting event. Anyone can call this — it's the simplest possible
/// user-driven on-chain action, which is what the template demos.
public fun mint(message: vector<u8>, ctx: &TxContext) {
	event::emit(Greeting {
		greeter: ctx.sender(),
		message,
	});
}
