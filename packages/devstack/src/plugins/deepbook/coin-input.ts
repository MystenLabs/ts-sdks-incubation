// Shared `splitInputCoin` for deepbook tx-builders. Used by:
//
//   - `swap.ts` — split the input coin (`amountIn`) for the swap.
//   - `market-maker.ts` — split each pre-deposit amount before
//     depositing into the maker's BalanceManager.
//
// Both paths split coins for the SAME purpose: extract `amount` units
// of `coinType` from `owner`'s coins as a transaction-input. SUI uses
// `tx.gas`; non-SUI uses `tx.mergeCoins` + `tx.splitCoins` against
// the owned coin set fetched via `client.core.listCoins`.

import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';

import { SUI_COIN_TYPE } from './coin-spec.js';

/**
 * Split `amount` units of `coinType` off `owner`'s coins, return the
 * resulting `TransactionObjectArgument` ready to pass into a moveCall
 * argument (or `transferObjects`). For SUI uses `tx.gas` (the active
 * gas coin); for non-SUI does an SDK `listCoins` + merge + split.
 *
 * Throws if `owner` has insufficient balance, or if no coins of the
 * requested type exist.
 *
 * `errorPrefix` is the leading string in any `Error.message` thrown,
 * so callers don't have to wrap to add context (deepbook.swap vs
 * deepbook.market-maker have different surfaces).
 */
export async function splitInputCoin(opts: {
	tx: Transaction;
	client: ClientWithCoreApi;
	owner: string;
	coinType: string;
	amount: bigint;
	errorPrefix: string;
}): Promise<TransactionObjectArgument> {
	const { tx, client, owner, coinType, amount, errorPrefix } = opts;
	if (coinType === SUI_COIN_TYPE) {
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
		if (coin === undefined) throw new Error(`${errorPrefix}: splitCoins(gas) returned no result`);
		return coin;
	}
	const { objects } = await client.core.listCoins({ owner, coinType });
	const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
	if (total < amount) {
		throw new Error(`${errorPrefix}: ${owner} has ${total} of ${coinType}; needs ${amount}`);
	}
	const [primary, ...rest] = objects;
	if (primary === undefined) throw new Error(`${errorPrefix}: no ${coinType} coins`);
	const primaryRef = tx.object(primary.objectId);
	if (rest.length > 0) {
		tx.mergeCoins(
			primaryRef,
			rest.map((c) => tx.object(c.objectId)),
		);
	}
	const [split] = tx.splitCoins(primaryRef, [tx.pure.u64(amount)]);
	if (split === undefined) throw new Error(`${errorPrefix}: splitCoins returned no result`);
	return split;
}
