module demo_coins::dbtc;

use sui::coin_registry;

public struct DBTC has drop {}

fun init(witness: DBTC, ctx: &mut TxContext) {
    let (builder, treasury_cap) = coin_registry::new_currency_with_otw(
        witness,
        8,
        b"DBTC".to_string(),
        b"Demo BTC".to_string(),
        b"Demo BTC for the devstack DeepBook trader example".to_string(),
        b"https://cryptologos.cc/logos/bitcoin-btc-logo.svg".to_string(),
        ctx,
    );

    let metadata_cap = builder.finalize(ctx);

    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_transfer(metadata_cap, ctx.sender());
}
