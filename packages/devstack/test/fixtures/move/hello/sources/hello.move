module hello::hello;

use sui::event;

public struct Greeting has copy, drop {
	greeter: address,
	message: vector<u8>,
}

public fun mint(message: vector<u8>, ctx: &TxContext) {
	event::emit(Greeting {
		greeter: ctx.sender(),
		message,
	});
}
