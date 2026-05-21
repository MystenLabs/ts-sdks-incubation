#[allow(deprecated_usage)]
module mock_usdc::mock_usdc;

use sui::coin::{Self, Coin, TreasuryCap};

/// One-time witness for the mock USDC coin.
public struct MOCK_USDC has drop {}

/// On publish: create the currency, freeze metadata, send TreasuryCap to publisher.
fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
	let (treasury, metadata) = coin::create_currency(
		witness,
		6,
		b"mUSDC",
		b"Mock USD Coin",
		b"Mock USDC for the Sui dev-examples wallet app",
		option::none(),
		ctx,
	);
	transfer::public_freeze_object(metadata);
	transfer::public_transfer(treasury, ctx.sender());
}

/// Mint `amount` to `recipient`. Caller must hold the TreasuryCap.
public fun mint(
	treasury: &mut TreasuryCap<MOCK_USDC>,
	amount: u64,
	recipient: address,
	ctx: &mut TxContext,
) {
	let coin = coin::mint(treasury, amount, ctx);
	transfer::public_transfer(coin, recipient);
}

/// Burn the supplied coin object. Caller must hold the TreasuryCap.
public fun burn(treasury: &mut TreasuryCap<MOCK_USDC>, coin: Coin<MOCK_USDC>) {
	coin::burn(treasury, coin);
}
