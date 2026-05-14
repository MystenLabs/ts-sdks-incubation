// Interface contract for a registered Move coin.
//
// `registerCoin` and `publishMove({coins})` both project a Move coin
// module into the manifest's `coins:` namespace. Phase 1 pins the
// shape every such per-named coin tag must satisfy so downstream
// consumers (dapp-kit's Faucet panel, manifest export, deepbook pool
// specs) can rely on a stable contract.

import { Context, Schema } from 'effect';

/** Minimal coin contract. `fullCoinType` is the on-chain
 *  `<package>::<module>::<TYPE>` Move type string consumers (deepbook,
 *  tx builders) splice into transactions.
 *
 *  `sdkCoin` is the SDK-aligned projection consumed verbatim by
 *  `@mysten/deepbook-v3` (and any other SDK that accepts a `Coin` value
 *  with `{ address, type, scalar }`). Derived from our fields:
 *    - `address` = the package portion of `fullCoinType` (text before `::`)
 *    - `type`    = `fullCoinType`
 *    - `scalar`  = `10 ** decimals`
 *
 *  Pyth fields (`feed`, `currencyId`, `priceInfoObjectId`) on the SDK's
 *  `Coin` shape are intentionally out of scope here — consumers that
 *  need them override per-coin in their own config layered on top.
 */
export interface CoinShape {
	readonly name: string;
	readonly fullCoinType: string;
	readonly decimals: number;
	/**
	 * SDK-ready coin entry. Pass directly to deepbook / dapp-kit utilities
	 * that consume `@mysten/deepbook-v3`'s `Coin` shape.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

export class Coin extends Context.Service<Coin, CoinShape>()('@devstack/Coin') {}

/**
 * Build the `sdkCoin` projection from our `(fullCoinType, decimals)`
 * pair. Exported because `registerCoin`, `publishMove({coins})`, and
 * the manifest emitter all need the same derivation — sharing a helper
 * keeps the projection consistent.
 */
export const toSdkCoin = (opts: {
	readonly fullCoinType: string;
	readonly decimals: number;
}): CoinShape['sdkCoin'] => {
	const sep = opts.fullCoinType.indexOf('::');
	const address = sep === -1 ? opts.fullCoinType : opts.fullCoinType.slice(0, sep);
	return {
		address,
		type: opts.fullCoinType,
		scalar: 10 ** opts.decimals,
	};
};

/** Runtime-validation mirror of `CoinShape`. Use
 *  `Schema.decode(CoinShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(Coin, ...)`, or in tests where you want to assert the
 *  shape on yield. */
export const CoinShapeSchema = Schema.Struct({
	name: Schema.String,
	fullCoinType: Schema.String,
	decimals: Schema.Number,
	sdkCoin: Schema.Struct({
		address: Schema.String,
		type: Schema.String,
		scalar: Schema.Number,
	}),
});
