// SUI local-faucet HTTP strategy.
//
// Wraps the in-stack `sui-faucet` HTTP server hosted by the local
// (or external) Sui container. The faucet URL comes from Sui's
// resolver (`ResolvedSuiNetwork.faucet`) at acquire time; the
// strategy CLOSES OVER the URL at construction, so the dispatch
// site never sees Sui context.
//
// Amount semantics: the local faucet returns a fixed-amount grant
// per request (the binary doesn't honor a variable amount today).
// We carry `amount` through to error payloads so exhaustion errors
// match the strategy-native unit (MIST), but the wire request
// itself does not include it.
//
// Distilled-doc opportunity #1 (`Generalize the strategy-registry
// pattern`): this file is the canonical small example. The whole
// strategy is 30-ish lines because everything wire-level lives in
// the shared `http.ts` helper.

import { Effect } from 'effect';

import { requestFundsWithRetry, type RetryOptions } from '../http.ts';
import type { FaucetBodyError, FaucetExhausted, FaucetUnreachable } from '../errors.ts';

/** Per-strategy options. */
export interface SuiLocalStrategyOptions {
	/** Faucet base URL — e.g. `http://localhost:9123`. The strategy
	 *  appends `/v2/gas` internally. */
	readonly faucetUrl: string;
	/** Wall-clock budget; forwarded to `requestFundsWithRetry`. */
	readonly timeoutMs?: number;
	/** Max retry attempts; forwarded to `requestFundsWithRetry`. */
	readonly maxAttempts?: number;
}

/**
 * Faucet strategy value. The dispatch surface is uniform across
 * strategies — the dispatcher doesn't know how a strategy delivers
 * coins, only how to invoke it.
 *
 * `amount` is in MIST (1 SUI = 10^9 MIST), the chain's smallest unit.
 * The local faucet binary itself ignores this and grants a fixed
 * amount per request; the parameter is here for type uniformity and
 * to land correctly-denominated values in `FaucetExhausted`.
 */
export interface FaucetStrategy {
	readonly request: (req: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void, FaucetExhausted | FaucetUnreachable | FaucetBodyError>;
}

/** Build a SUI local-faucet HTTP strategy. */
export const suiLocalStrategy = (opts: SuiLocalStrategyOptions): FaucetStrategy => ({
	request: ({ address, amount }) => {
		const retryOpts: RetryOptions = {
			faucetUrl: opts.faucetUrl,
			address,
			amount,
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
		};
		return requestFundsWithRetry(retryOpts);
	},
});
