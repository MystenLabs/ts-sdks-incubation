module counter::counter;

/// A trivial shared counter. The simplest possible piece of mutable
/// on-chain state: anyone can create one (it is shared), and anyone can
/// increment it. The template's core panel creates one, increments it,
/// and reads the value back over the generated bindings.
public struct Counter has key, store {
	id: UID,
	owner: address,
	value: u64,
}

/// Create a shared `Counter` owned (by record) by the caller, starting
/// at zero. Shared so any account can increment it without a transfer.
entry fun create_and_share(ctx: &mut TxContext) {
	let counter = Counter {
		id: object::new(ctx),
		owner: ctx.sender(),
		value: 0,
	};
	transfer::share_object(counter);
}

/// Increment the counter by one. Entry so the UI can call it directly.
entry fun increment_entry(counter: &mut Counter) {
	counter.value = counter.value + 1;
}

/// Read the current value.
public fun value(counter: &Counter): u64 {
	counter.value
}
