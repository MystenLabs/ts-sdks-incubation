// SUI HTTP faucet strategy. Wraps the existing `engine/faucet.ts`
// `requestFunds` so the new strategy registry surfaces it as a
// `FaucetStrategy`. Honors the same retry budget defaults the legacy
// path used.
//
// `amount` is ignored — the localnet faucet ignores the requested
// amount today (it funds a fixed amount per request). We accept the
// parameter so the strategy signature stays uniform, and forward-pass
// it through the FaucetStrategy interface for future use when the
// server-side faucet honors variable amounts.

import { Effect } from 'effect';
import { requestFunds } from '../../../engine/faucet.js';
import { FaucetRequestError, type FaucetStrategy } from '../index.js';

export interface SuiHttpStrategyOptions {
	/** Faucet base URL — e.g. `http://localhost:9123`. The strategy
	 *  appends `/v2/gas` internally. */
	readonly faucetUrl: string;
	/** Wall-clock budget for the entire request. Forwarded to
	 *  `requestFunds`. Default 90s (`requestFunds`'s own default). */
	readonly timeoutMs?: number;
	/** Max retry attempts. Forwarded to `requestFunds`. */
	readonly maxAttempts?: number;
}

/** Build a SUI HTTP faucet strategy. Drop into
 *  `Faucet.register(suiHttpStrategy({ faucetUrl }))` or rely on
 *  `Faucet({...})` to wire it automatically from the resolved `SuiTag`. */
export const suiHttpStrategy = (opts: SuiHttpStrategyOptions): FaucetStrategy => ({
	coinType: 'SUI',
	request: ({ address, amount }) =>
		requestFunds({
			faucetUrl: opts.faucetUrl,
			address,
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
		}).pipe(
			Effect.mapError(
				(cause) =>
					new FaucetRequestError({
						coinType: 'SUI',
						address,
						amount,
						message: `SUI faucet at ${opts.faucetUrl} failed: ${cause.message}`,
						cause,
					}),
			),
		),
});
