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

import { leaseKey, type LeaseBroker } from '../../../substrate/runtime/lease-broker/index.ts';
import { requestFundsWithRetry, type RetryOptions } from '../http.ts';
import type { FaucetBodyError, FaucetExhausted, FaucetUnreachable } from '../errors.ts';

/** Optional serialization for faucet backends that spend a shared funding coin. */
export interface SuiLocalFaucetSerialization {
	/** Stack-local broker; callers choose the resource key shape. */
	readonly broker: LeaseBroker;
	/** Opaque lease key, typically scoped by chain id. */
	readonly key: string;
	/** Diagnostic owner reported by the lease broker. */
	readonly owner: string;
}

/** Per-strategy options. */
export interface SuiLocalStrategyOptions {
	/** Faucet base URL — e.g. `http://localhost:9123`. The strategy
	 *  appends `/v2/gas` internally. */
	readonly faucetUrl: string;
	/** Wall-clock budget; forwarded to `requestFundsWithRetry`. */
	readonly timeoutMs?: number;
	/** Max retry attempts; forwarded to `requestFundsWithRetry`. */
	readonly maxAttempts?: number;
	/** Serialize requests when the faucet backend shares one funding coin. */
	readonly serialization?: SuiLocalFaucetSerialization;
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

const withSerialization = <E>(
	serialization: SuiLocalFaucetSerialization | undefined,
	effect: Effect.Effect<void, E>,
): Effect.Effect<void, E> => {
	if (serialization === undefined) {
		return effect;
	}
	return Effect.scoped(
		Effect.gen(function* () {
			yield* serialization.broker.acquire(leaseKey(serialization.key), serialization.owner);
			yield* effect;
		}),
	).pipe(
		Effect.withSpan('faucet.suiLocal.serializedRequest', {
			attributes: {
				'faucet.lease.key': serialization.key,
				'faucet.lease.owner': serialization.owner,
			},
		}),
	);
};

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
		return withSerialization(opts.serialization, requestFundsWithRetry(retryOpts));
	},
});
