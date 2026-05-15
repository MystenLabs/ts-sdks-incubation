// Faucet(...) — the auto-included Ref that wires built-in strategies
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

import { Context, Effect, Layer } from 'effect';
import { tag, type Ref } from '../advanced/tag.js';
import { SuiTag } from '../services/sui.js';
import { FaucetLive, FaucetTag, type FaucetStrategy } from './service.js';
import { suiHttpStrategy } from './strategies/sui-http.js';

export interface FaucetOptions {
	/** Additional strategies to register at acquire time. The built-in
	 *  SUI HTTP strategy (when available) is registered first; these
	 *  run after, so a caller-supplied strategy for `'SUI'` overrides
	 *  the default. */
	readonly strategies?: ReadonlyArray<FaucetStrategy>;
	/** Override tag name. Defaults to `'faucet'`. */
	readonly name?: string;
}

/** The Faucet Ref. Yields `FaucetTag`. */
export const Faucet = (opts: FaucetOptions = {}): Ref<'faucet', unknown, never, never> => {
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
	) as unknown as Ref<'faucet', unknown, never, never>;
};
