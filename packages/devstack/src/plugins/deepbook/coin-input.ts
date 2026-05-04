// `splitInputCoin` helper for deepbook's market-maker. Wraps
// `tx.coin({ balance, type, useGasCoin: false })` — the SDK
// resolver picks the cheapest source (address-balance withdrawal
// when the sender's accumulator has enough, owned coin objects
// otherwise). `useGasCoin: false` keeps it gas-mode-agnostic so
// the same builder works whether the signing path uses coin gas
// or address-balance gas.

import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';

/**
 * Get `amount` units of `coinType` as a `Coin<T>` ready to pass into
 * a moveCall argument or `transferObjects`. The SDK resolves the
 * source automatically (address-balance withdrawal preferred, then
 * owned coin objects). Throws at execution time if the sender has
 * insufficient balance.
 *
 * `errorPrefix` is unused at build time today — kept on the surface
 * for backward compatibility with the prior splitInputCoin shape and
 * for diagnostic messages plugins prepend to caught errors.
 */
export function splitInputCoin(opts: {
	tx: Transaction;
	owner: string;
	coinType: string;
	amount: bigint;
	errorPrefix: string;
}): TransactionObjectArgument {
	return opts.tx.coin({
		balance: opts.amount,
		type: opts.coinType,
		useGasCoin: false,
	});
}
