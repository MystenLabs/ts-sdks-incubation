#[allow(deprecated_usage)]
module token_studio::managed_coin;

use sui::coin::{Self, TreasuryCap};
use sui::url;

/// One-time witness for the demo coin.
public struct MANAGED_COIN has drop {}

/// On publish: create the currency, freeze metadata, send TreasuryCap to publisher.
fun init(witness: MANAGED_COIN, ctx: &mut TxContext) {
	let (treasury, metadata) = coin::create_currency(
		witness,
		6,
		b"STUDIO",
		b"Studio Token",
		b"Demo coin minted from the Sui dev-examples token studio",
		option::some(url::new_unsafe_from_bytes(b"https://sui.io/favicon.ico")),
		ctx,
	);
	transfer::public_freeze_object(metadata);
	transfer::public_transfer(treasury, ctx.sender());
}

/// Mint `amount` to `recipient`. Caller must hold the TreasuryCap.
public fun mint(
	treasury: &mut TreasuryCap<MANAGED_COIN>,
	amount: u64,
	recipient: address,
	ctx: &mut TxContext,
) {
	let coin = coin::mint(treasury, amount, ctx);
	transfer::public_transfer(coin, recipient);
}
