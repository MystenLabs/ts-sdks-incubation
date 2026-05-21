// SUI live-faucet HTTP strategy.
//
// Wraps the public testnet/devnet faucet endpoint. Wire shape is the
// same as `sui-local` — same `/v2/gas` POST, same body-Failure
// semantics — but the retry profile is sized differently in practice
// (public faucets are rate-limited, not boot-warming).
//
// Distilled-doc open question §1 ("Does the public testnet faucet
// honor the same request/response shape?"): assumed YES today; the
// shared HTTP helper raises on body-level Failure either way, so a
// shape divergence surfaces as a clear `FaucetBodyError` rather than
// a silent miss.

import { Effect } from 'effect';

import { requestFundsWithRetry, type RetryOptions } from '../http.ts';
import type { FaucetBodyError, FaucetExhausted, FaucetUnreachable } from '../errors.ts';
import type { FaucetStrategy } from './sui-local.ts';

/** Known live network → default faucet URL mapping. Mainnet is
 *  intentionally absent: there is no mainnet faucet, and the
 *  faucet plugin's contract on that network is "no strategy is
 *  registered for SUI; ephemeral-funded accounts fail at acquire
 *  with an actionable error". */
export const LIVE_FAUCET_URLS = {
	testnet: 'https://faucet.testnet.sui.io',
	devnet: 'https://faucet.devnet.sui.io',
} as const;

export type SuiLiveNetwork = keyof typeof LIVE_FAUCET_URLS;

/** Per-strategy options. */
export interface SuiLiveStrategyOptions {
	/** Either a known network discriminator OR an explicit URL.
	 *  Explicit URL wins (custom live networks). */
	readonly network?: SuiLiveNetwork;
	readonly faucetUrl?: string;
	/** Wall-clock budget. Default = shared `DEFAULT_TIMEOUT_MS`. */
	readonly timeoutMs?: number;
	/** Max retry attempts. */
	readonly maxAttempts?: number;
}

/** Resolve the faucet URL from the option record. */
const resolveLiveFaucetUrl = (opts: SuiLiveStrategyOptions): string => {
	if (opts.faucetUrl !== undefined) return opts.faucetUrl;
	if (opts.network !== undefined) return LIVE_FAUCET_URLS[opts.network];
	throw new Error(
		'suiLiveStrategy: pass either `network` or `faucetUrl` ' +
			'(mainnet has no faucet — do not construct this strategy for mainnet).',
	);
};

/** Build a SUI live-faucet HTTP strategy. */
export const suiLiveStrategy = (opts: SuiLiveStrategyOptions): FaucetStrategy => {
	const faucetUrl = resolveLiveFaucetUrl(opts);
	return {
		request: ({
			address,
			amount,
		}: {
			readonly address: string;
			readonly amount: bigint;
		}): Effect.Effect<void, FaucetExhausted | FaucetUnreachable | FaucetBodyError> => {
			const retryOpts: RetryOptions = {
				faucetUrl,
				address,
				amount,
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
				...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
			};
			return requestFundsWithRetry(retryOpts);
		},
	};
};
