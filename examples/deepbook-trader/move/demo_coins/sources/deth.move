module demo_coins::deth;

use sui::coin_registry;

public struct DETH has drop {}

fun init(witness: DETH, ctx: &mut TxContext) {
    let (builder, treasury_cap) = coin_registry::new_currency_with_otw(
        witness,
        8,
        b"DETH".to_string(),
        b"Demo ETH".to_string(),
        b"Demo ETH for the devstack DeepBook trader example".to_string(),
        b"https://cryptologos.cc/logos/ethereum-eth-logo.svg".to_string(),
        ctx,
    );

    let metadata_cap = builder.finalize(ctx);

    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_transfer(metadata_cap, ctx.sender());
}
