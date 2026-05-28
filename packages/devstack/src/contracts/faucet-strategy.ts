// Cross-plugin faucet-request strategy contract.
//
// Neutral substrate contract shared by the `faucet` plugin (which
// dispatches strategies via the strategy registry keyed by chain id)
// and the contributing plugins (`sui` local + live, future
// user-authored faucet-style strategies) that ship strategies for
// specific chain ids.
//
// Architecture (ARCHITECTURE.md §"Plugin A ↔ Plugin B coupling"):
//   - Faucet is the dispatch bus; it OWNS the capability-key prefix
//     (`faucet:request:<chainId>`) and the dispatcher closure.
//   - Sui (and future contributors) ship per-chain `FaucetStrategy`
//     values via `strategyContributor` decls.
//
// Lifting the shared shape here breaks the Faucet↔Sui round-trip
// cross-import. Plugin barrels re-export for ergonomics — the faucet
// plugin's `dispatcher.ts` re-exports the form narrowed to the faucet
// plugin's tagged error union (`FaucetExhausted | FaucetUnreachable |
// FaucetBodyError`) so existing consumers continue to see the same
// type alias.
//
// The interface is generic over the strategy's own error channel
// (`E`). The substrate stays name-blind per STYLE_GUIDE §7; the
// faucet plugin barrel re-exports a narrowed alias. Strategies
// shipped by contributing plugins target the narrowed faucet-barrel
// form and never reach for the substrate generic directly.
//
// Distilled invariant (faucet plugin errors module): a non-2xx HTTP
// status MUST raise; a 200 OK body carrying `{ status: { Failure } }`
// MUST raise. Strategies that satisfy `FaucetStrategy<E>` are
// expected to preserve that invariant inside their `request` body.

import type { Effect } from 'effect';

/** Request passed to faucet strategies. `amount` is the chain-native
 *  smallest unit (MIST for SUI). Some backends (the local sui-faucet
 *  binary) grant a fixed amount per request and IGNORE this value;
 *  the parameter is here for type uniformity and to land
 *  correctly-denominated values in tagged exhaustion errors. */
export interface FaucetRequest {
	readonly address: string;
	readonly amount: bigint;
}

/** Strategy interface a contributing plugin satisfies to participate
 *  in cross-cutting faucet dispatch for a specific chain id. Generic
 *  over the strategy's own error channel (`E`).
 *
 *  The dispatch surface is uniform across strategies — the
 *  dispatcher doesn't know how a strategy delivers coins, only how
 *  to invoke it. */
export interface FaucetStrategy<E = unknown> {
	readonly request: (req: FaucetRequest) => Effect.Effect<void, E>;
}
