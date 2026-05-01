#[allow(deprecated_usage)]
module mock_weth::mock_weth;

use sui::coin::{Self, Coin, TreasuryCap};

/// One-time witness for the mock WETH coin.
public struct MOCK_WETH has drop {}

/// On publish: create the currency, freeze metadata, send TreasuryCap to publisher.
fun init(witness: MOCK_WETH, ctx: &mut TxContext) {
	let (treasury, metadata) = coin::create_currency(
		witness,
		8,
		b"mWETH",
		b"Mock Wrapped Ether",
		b"Mock WETH for the Sui dev-examples wallet app",
		option::none(),
		ctx,
	);
	transfer::public_freeze_object(metadata);
	transfer::public_transfer(treasury, ctx.sender());
}

/// Mint `amount` to `recipient`. Caller must hold the TreasuryCap.
public fun mint(
	treasury: &mut TreasuryCap<MOCK_WETH>,
	amount: u64,
	recipient: address,
	ctx: &mut TxContext,
) {
	let coin = coin::mint(treasury, amount, ctx);
	transfer::public_transfer(coin, recipient);
}

/// Burn the supplied coin object. Caller must hold the TreasuryCap.
public fun burn(treasury: &mut TreasuryCap<MOCK_WETH>, coin: Coin<MOCK_WETH>) {
	coin::burn(treasury, coin);
}
