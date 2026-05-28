// SUI local-faucet HTTP strategy.
//
// Architecture: the Sui plugin OWNS the local-faucet endpoint
// conceptually — it spins up the `sui-faucet` container in
// `mode/local.ts`. The strategy CLOSES OVER the faucet URL at
// construction so the dispatch site never sees Sui context, and is
// registered into the `faucet:request:<chainId>` strategy registry
// via a `StrategyContributor` decl from `sui/index.ts`.
//
// `FaucetStrategy` (the dispatch shape) is the faucet plugin's
// contract surface and is imported from `../faucet/index.ts` — the
// sui plugin only depends on faucet for the type, not for the
// implementation. That keeps the dependency direction faucet ← sui,
// matching the user-facing fact that `sui()` is the owner of the
// faucet container.
//
// Amount semantics: the local faucet returns a fixed-amount grant
// per request (the binary doesn't honor a variable amount today).
// We carry `amount` through to error payloads so exhaustion errors
// match the strategy-native unit (MIST), but the wire request
// itself does not include it.

import { Effect } from 'effect';

import { leaseKey, type LeaseBroker } from '../../substrate/runtime/lease-broker/index.ts';
import { requestFundsWithRetry, type FaucetStrategy, type RetryOptions } from '../faucet/index.ts';

import { SuiSpans } from './spans.ts';

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
		Effect.withSpan('devstack.plugin.sui.localFaucet.serializedRequest', {
			attributes: {
				[SuiSpans.localFaucetLeaseKey]: serialization.key,
				[SuiSpans.localFaucetLeaseOwner]: serialization.owner,
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
