// `buildDeepbookSwapTx` — produces a Transaction that swaps `amountIn` of
// `inCoinType` for the other side of a DeepBook v3 pool. Used by frontend
// code (`tx.add(swap.buildTx(...))`) and tests; exported from the
// deepbook plugin.

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction, type TransactionResult } from '@mysten/sui/transactions';

import { SUI_COIN_TYPE } from './coin-spec.js';

const SUI_CLOCK_OBJECT_ID = '0x6';

export interface BuildSwapTxOptions {
	client: ClientWithCoreApi;
	sender: string;
	deepbookPackageId: string;
	poolId: string;
	baseCoinType: string;
	quoteCoinType: string;
	direction: 'base_to_quote' | 'quote_to_base';
	amountIn: bigint;
	/** Slippage guard — minimum quote (or base) units expected out. Pass 0
	 * for "any output" or compute from a pre-quote. */
	minOut: bigint;
}

/**
 * Build a swap against a whitelisted DeepBook v3 pool. Splits `amountIn`
 * worth of input coin from the sender's owned coins (`tx.gas` for SUI,
 * merge+split for non-SUI), passes a zero `Coin<DEEP>` placeholder (the
 * pool's whitelist setting waives DEEP fees), calls
 * `pool::swap_exact_base_for_quote` or `swap_exact_quote_for_base`, and
 * transfers the returned coins back to the sender.
 *
 * `--with-unpublished-dependencies` inlines DeepBook's `token` sub-
 * package under the parent address, so DEEP's coin type is at
 * `${deepbookPackageId}::deep::DEEP`.
 */
export async function buildDeepbookSwapTx(opts: BuildSwapTxOptions): Promise<Transaction> {
	const tx = new Transaction();
	const inCoinType = opts.direction === 'base_to_quote' ? opts.baseCoinType : opts.quoteCoinType;

	const inCoin = await splitInputCoin(tx, opts.client, opts.sender, inCoinType, opts.amountIn);
	const deepCoin = tx.moveCall({
		target: '0x2::coin::zero',
		typeArguments: [`${opts.deepbookPackageId}::deep::DEEP`],
		arguments: [],
	});

	const target =
		opts.direction === 'base_to_quote'
			? `${opts.deepbookPackageId}::pool::swap_exact_base_for_quote`
			: `${opts.deepbookPackageId}::pool::swap_exact_quote_for_base`;

	const result = tx.moveCall({
		target,
		typeArguments: [opts.baseCoinType, opts.quoteCoinType],
		arguments: [
			tx.object(opts.poolId),
			inCoin,
			deepCoin,
			tx.pure.u64(opts.minOut),
			tx.object(SUI_CLOCK_OBJECT_ID),
		],
	});

	// `swap_exact_*` returns (Coin<Base>, Coin<Quote>, Coin<DEEP>). Transfer
	// all three back so any leftovers (rounding, partial fills) don't get
	// stuck on the gas object.
	const baseOut = (result as TransactionResult)[0];
	const quoteOut = (result as TransactionResult)[1];
	const deepOut = (result as TransactionResult)[2];
	if (baseOut === undefined || quoteOut === undefined || deepOut === undefined) {
		throw new Error('buildDeepbookSwapTx: swap_exact_* returned fewer than 3 results');
	}
	tx.transferObjects([baseOut, quoteOut, deepOut], opts.sender);
	return tx;
}

async function splitInputCoin(
	tx: Transaction,
	client: ClientWithCoreApi,
	owner: string,
	coinType: string,
	amount: bigint,
) {
	if (coinType === SUI_COIN_TYPE) {
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
		if (coin === undefined) throw new Error('splitCoins(gas) returned no result');
		return coin;
	}
	const { objects } = await client.core.listCoins({ owner, coinType });
	const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
	if (total < amount) {
		throw new Error(`buildDeepbookSwapTx: ${owner} has ${total} of ${coinType}; needs ${amount}`);
	}
	const [primary, ...rest] = objects;
	if (primary === undefined) throw new Error(`buildDeepbookSwapTx: no ${coinType} coins`);
	const primaryRef = tx.object(primary.objectId);
	if (rest.length > 0) {
		tx.mergeCoins(
			primaryRef,
			rest.map((c) => tx.object(c.objectId)),
		);
	}
	const [split] = tx.splitCoins(primaryRef, [tx.pure.u64(amount)]);
	if (split === undefined) throw new Error('splitCoins returned no result');
	return split;
}
