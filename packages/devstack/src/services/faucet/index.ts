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
//
// This file is the single facade for the Faucet subsystem. It bundles:
//   - the `Faucet(...)` LayeredTag factory (the public surface users wire
//     into `devstack(...)`),
//   - the `FaucetTag` / `FaucetLive` service layer + interface,
//   - the `FaucetStrategy` interface that plugin authors implement,
//   - the `FaucetRequestError` tagged error every strategy surfaces.
// Strategy implementations live under `./strategies/` so this file stays
// focused on the contract.

import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { suiHttpStrategy } from './strategies/sui-http.js';

/** Tagged error surfaced by every Faucet strategy. The `coinType` field
 *  carries the coin the request was for (e.g. `'SUI'`, `'WAL'`, or a
 *  fully-qualified Move type) so a multi-strategy run's error message
 *  points at the right strategy. */
export class FaucetRequestError extends Schema.TaggedErrorClass<FaucetRequestError>()(
	'FaucetRequestError',
	{
		coinType: Schema.String,
		address: Schema.String,
		amount: Schema.BigInt,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** A faucet strategy for one coin type. */
export interface FaucetStrategy {
	/** CoinTag discriminator. The convention is short canonical names for
	 *  built-in coins (`'SUI'`, `'WAL'`) and fully-qualified Move types
	 *  (`'0xpkg::module::Name'`) for user coins. */
	readonly coinType: string;
	/**
	 * Fund `address` with `amount` units. The Effect's `E` channel is
	 * pinned to `FaucetRequestError` for uniform error handling at the
	 * call site; strategies that wrap other tagged errors should
	 * `mapError` into one before returning.
	 *
	 * **The unit `amount` is denominated in depends on the strategy** —
	 * the interface is intentionally loose so each registered strategy
	 * can pick the most natural unit for its underlying call. Built-in
	 * strategies use the following conventions; plugin-author strategies
	 * should document their own choice in JSDoc:
	 *
	 * - `suiHttpStrategy` — **ignores** `amount`. The SUI HTTP faucet
	 *   returns a fixed grant per request and has no variable-amount
	 *   API today. The parameter is accepted to keep the strategy
	 *   signature uniform and forward-compatible.
	 * - `walExchangeStrategy` — `amount` is **SUI MIST** to spend on the
	 *   WAL swap (matching `Walrus({ local: { seedPaymentMist } })`'s
	 *   semantics). `amount === 0n` falls back to `defaultPaymentMist`.
	 *   The resulting WAL is whatever `exchange_all_for_wal` returns at
	 *   the current rate — callers do not pick an exact WAL amount.
	 * - `treasuryCapMintStrategy` — `amount` is **units in the coin's
	 *   smallest denomination** (raw `u64`), matching the
	 *   `0x2::coin::mint_and_transfer` Move signature directly.
	 *   `amount === 0n` is treated as a no-op.
	 *
	 * @param opts.address Destination address to fund.
	 * @param opts.amount Strategy-defined unit; see the per-strategy
	 *   notes above.
	 */
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
export class FaucetTag extends Context.Service<FaucetTag, Faucet>()('@devstack/FaucetTag') {}

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

// Faucet(...) — the auto-included LayeredTag that wires built-in strategies
// against the resolved stack. `devstack(...)` adds a `Faucet()` to
// every stack so `Account({ funding })` always finds a registered
// strategy for the common coin types (SUI, WAL, user coins via
// TreasuryCap).
//
// Architecture: at acquire time the body
//   1. Yields the strategies the caller passed explicitly (none in the
//      auto-included case);
//   2. Best-effort yields `SuiTag` and registers the SUI HTTP strategy
//      when `sui.faucet` is present (localnet always; testnet often).
//   3. Returns the resolved Faucet shape so `Account({ funding })`'s
//      `yield* FaucetTag` resolves.
//
// `WAL` (walrus exchange swap) and `<pkg>::<mod>::<Name>` (TreasuryCap
// mint) strategies are NOT auto-wired yet — that requires walrus /
// PackageRegistry resolution that we'll fold in once the deeper
// integration lands. Until then, users that need WAL or user-coin
// funding register the strategy explicitly via `Faucet({ strategies:
// [...] })`.

export interface FaucetOptions {
	/** Additional strategies to register at acquire time. The built-in
	 *  SUI HTTP strategy (when available) is registered first; these
	 *  run after, so a caller-supplied strategy for `'SUI'` overrides
	 *  the default. */
	readonly strategies?: ReadonlyArray<FaucetStrategy>;
	/** Override tag name. Defaults to `'faucet'`. */
	readonly name?: string;
}

/** The Faucet LayeredTag. Yields `FaucetTag`. */
export const Faucet = (opts: FaucetOptions = {}): LayeredTag<'faucet', unknown, never, never> => {
	const name = opts.name ?? 'faucet';
	const callerStrategies = opts.strategies ?? [];
	return tag(
		`faucet/${name}` as const,
		Effect.gen(function* () {
			// Build the live Faucet inside the Effect so the strategy
			// registry has the same lifecycle as the tag's scope.
			const ctx = yield* Layer.build(FaucetLive);
			const faucet = Context.get(ctx, FaucetTag);

			// Built-in: SUI HTTP strategy when sui.faucet is reachable.
			// Using Effect.serviceOption lets the Faucet ref still build
			// in unit tests that only provide the Faucet layer (no Sui).
			const suiOpt = yield* Effect.serviceOption(SuiTag);
			if (suiOpt._tag === 'Some' && suiOpt.value.faucet !== undefined) {
				yield* faucet.register(suiHttpStrategy({ faucetUrl: suiOpt.value.faucet.host }));
			}

			// Caller-supplied strategies. Registered last so they win
			// over built-ins for overlapping `coinType`s.
			for (const s of callerStrategies) {
				yield* faucet.register(s);
			}

			return faucet;
		}),
		{
			kind: 'service',
			displayTitle: `faucet.${name}`,
			display: () => ({ title: `faucet.${name}` }),
		},
	) as unknown as LayeredTag<'faucet', unknown, never, never>;
};
