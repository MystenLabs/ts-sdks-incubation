#[allow(deprecated_usage)]
module deep::deep;

use sui::coin::{Self, Coin, TreasuryCap};

/// One-time witness for the local DEEP coin.
public struct DEEP has drop {}

/// On publish: create the currency, freeze metadata, send TreasuryCap to publisher.
fun init(witness: DEEP, ctx: &mut TxContext) {
	let (treasury, metadata) = coin::create_currency(
		witness,
		6,
		b"DEEP",
		b"Local DEEP",
		b"Local DEEP token for the devstack DeepBook trader example",
		option::none(),
		ctx,
	);
	transfer::public_freeze_object(metadata);
	transfer::public_transfer(treasury, ctx.sender());
}

/// Mint `amount` to `recipient`. Caller must hold the TreasuryCap.
public fun mint(
	treasury: &mut TreasuryCap<DEEP>,
	amount: u64,
	recipient: address,
	ctx: &mut TxContext,
) {
	let coin = coin::mint(treasury, amount, ctx);
	transfer::public_transfer(coin, recipient);
}

/// Burn the supplied coin object. Caller must hold the TreasuryCap.
public fun burn(treasury: &mut TreasuryCap<DEEP>, coin: Coin<DEEP>) {
	coin::burn(treasury, coin);
}
