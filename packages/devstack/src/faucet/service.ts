// Faucet service. Centralizes coin-funding through pluggable per-coin
// strategies.
//
// Architecture
// ------------
// A strategy is `{ coinType, request }`. `request({address, amount})`
// produces an Effect that funds the address with `amount` units of
// `coinType`. Built-in strategies cover SUI (HTTP faucet on localnet /
// testnet) and Walrus (`WAL`) and user-coin mint via TreasuryCap; user
// code can register additional strategies via `Faucet.register`.
//
// `Faucet.requestCoin(coinType, address, amount)` dispatches to the
// matching strategy. Unknown `coinType` → `FaucetRequestError`.
//
// The service is yielded by `Account({ funding })` at acquire time, so
// each account requests its declared coins after its keypair is
// resolved but before downstream refs (Package, Action) start
// consuming it.
//
// Strategies are intentionally loose on their `R` channel — wrapping
// the existing SUI HTTP path keeps it `never`, but a future WAL strategy
// that needs `SuiTag` + a published walrus deploy ref will widen R.

import { Context, Effect, Layer, Ref } from 'effect';
import { FaucetRequestError } from './errors.js';

/** A faucet strategy for one coin type. */
export interface FaucetStrategy {
	/** CoinTag discriminator. The convention is short canonical names for
	 *  built-in coins (`'SUI'`, `'WAL'`) and fully-qualified Move types
	 *  (`'0xpkg::module::Name'`) for user coins. */
	readonly coinType: string;
	/** Fund `address` with `amount` units. The Effect's `E` channel is
	 *  pinned to `FaucetRequestError` for uniform error handling at the
	 *  call site; strategies that wrap other tagged errors should
	 *  `mapError` into one before returning. */
	readonly request: (opts: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void, FaucetRequestError, never>;
}

/** Faucet service shape. */
export interface Faucet {
	/** Register a strategy. Later registrations for the same `coinType`
	 *  shadow earlier ones — useful for tests that want to stub a
	 *  built-in strategy with a deterministic fake. */
	readonly register: (strategy: FaucetStrategy) => Effect.Effect<void>;
	/** Dispatch a funding request to the matching strategy. Fails with
	 *  `FaucetRequestError` if no strategy is registered for
	 *  `coinType`. */
	readonly requestCoin: (
		coinType: string,
		address: string,
		amount: bigint,
	) => Effect.Effect<void, FaucetRequestError>;
	/** Snapshot of every coin currently fundable through this faucet.
	 *  Manifest emitters fold this into `coins[*].fundable`. */
	readonly listFundable: Effect.Effect<ReadonlyArray<string>>;
}

/** Canonical Faucet tag. The service is auto-included by `devstack(...)`
 *  so primitives can `yield* FaucetTag` without the user wiring it. */
export class FaucetTag extends Context.Service<FaucetTag, Faucet>()('@devstack/Faucet') {}

/** Live implementation. Strategies live in a per-instance `Ref<Map>`
 *  keyed by `coinType`. Concurrent `register` calls are safe via
 *  `Ref.update`. */
export const FaucetLive: Layer.Layer<FaucetTag> = Layer.effect(
	FaucetTag,
	Effect.gen(function* () {
		const strategies = yield* Ref.make<Map<string, FaucetStrategy>>(new Map());
		const shape: Faucet = {
			register: (strategy) =>
				Ref.update(strategies, (m) => {
					const next = new Map(m);
					next.set(strategy.coinType, strategy);
					return next;
				}),
			requestCoin: (coinType, address, amount) =>
				Effect.gen(function* () {
					const map = yield* Ref.get(strategies);
					const strategy = map.get(coinType);
					if (strategy === undefined) {
						const known = [...map.keys()].join(', ') || '<none>';
						return yield* Effect.fail(
							new FaucetRequestError({
								coinType,
								address,
								amount,
								message: `Faucet: no strategy registered for '${coinType}' (registered: ${known})`,
							}),
						);
					}
					yield* strategy.request({ address, amount });
				}),
			listFundable: Ref.get(strategies).pipe(Effect.map((m) => [...m.keys()])),
		};
		return shape;
	}),
);
