import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { SUI_COIN_TYPE } from './queries.js';

// Sui's system Clock object — required by DeepBook entry functions that use
// timestamps for matching (passed by reference, not consumed).
const SUI_CLOCK_OBJECT_ID = '0x6';

/**
 * Build a transaction that sends `amount` (raw base units) of `coinType` to
 * `recipient`. SUI splits from `tx.gas`; non-SUI coins resolve owned objects,
 * merge, then split — see notes/friction.md re: the v2 SDK lacking
 * `tx.coinWithBalance` while pinned to dapp-kit's @mysten/sui version.
 */
export async function buildSendTx(args: {
	client: ClientWithCoreApi;
	sender: string;
	coinType: string;
	amount: bigint;
	recipient: string;
}): Promise<Transaction> {
	const { client, sender, coinType, amount, recipient } = args;

	if (coinType === SUI_COIN_TYPE) {
		const tx = new Transaction();
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
		if (!coin) throw new Error('splitCoins returned no result');
		tx.transferObjects([coin], recipient);
		return tx;
	}

	const { objects } = await client.core.listCoins({ owner: sender, coinType });
	if (objects.length === 0) throw new Error(`No ${coinType} coins owned by this account`);

	const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
	if (total < amount) {
		throw new Error(`Insufficient balance: have ${total}, need ${amount}`);
	}

	const tx = new Transaction();
	const [primary, ...rest] = objects;
	if (!primary) throw new Error(`No ${coinType} coins owned by this account`);
	const primaryRef = tx.object(primary.objectId);

	if (rest.length > 0) {
		tx.mergeCoins(
			primaryRef,
			rest.map((c) => tx.object(c.objectId)),
		);
	}

	const [split] = tx.splitCoins(primaryRef, [tx.pure.u64(amount)]);
	if (!split) throw new Error('splitCoins returned no result');
	tx.transferObjects([split], recipient);
	return tx;
}

/**
 * Build a swap transaction against a DeepBook v3 pool. Splits `amountIn`
 * worth of `inCoinType` from the sender's owned coins (or `tx.gas` if SUI),
 * passes a zero `Coin<DEEP>` placeholder (whitelisted pools waive DEEP fees),
 * calls `pool::swap_exact_base_for_quote` or `swap_exact_quote_for_base`
 * depending on direction, and transfers the returned coins back.
 *
 * The pool's argument order is fixed: base first, deep second, min_out third.
 * `min_out` is a slippage guard; pass 0 for "any output" or compute from a
 * pre-quote.
 */
export async function buildDeepbookSwapTx(args: {
	client: ClientWithCoreApi;
	sender: string;
	deepbookPackageId: string;
	poolId: string;
	baseCoinType: string;
	quoteCoinType: string;
	direction: 'base_to_quote' | 'quote_to_base';
	amountIn: bigint;
	minOut: bigint;
}): Promise<Transaction> {
	const {
		client,
		sender,
		deepbookPackageId,
		poolId,
		baseCoinType,
		quoteCoinType,
		direction,
		amountIn,
		minOut,
	} = args;

	const inCoinType = direction === 'base_to_quote' ? baseCoinType : quoteCoinType;
	const tx = new Transaction();

	// Source the input amount: SUI splits from gas; non-SUI lists+merges+splits
	// owned coins.
	const inCoin = await sourceCoin();
	async function sourceCoin() {
		if (inCoinType === SUI_COIN_TYPE) {
			const [split] = tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)]);
			if (!split) throw new Error('splitCoins returned no result');
			return split;
		}
		const { objects } = await client.core.listCoins({ owner: sender, coinType: inCoinType });
		if (objects.length === 0) throw new Error(`No ${inCoinType} coins owned by this account`);
		const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
		if (total < amountIn) {
			throw new Error(`Insufficient balance: have ${total}, need ${amountIn}`);
		}
		const [primary, ...rest] = objects;
		if (!primary) throw new Error(`No ${inCoinType} coins`);
		const primaryRef = tx.object(primary.objectId);
		if (rest.length > 0) {
			tx.mergeCoins(
				primaryRef,
				rest.map((c) => tx.object(c.objectId)),
			);
		}
		const [split] = tx.splitCoins(primaryRef, [tx.pure.u64(amountIn)]);
		if (!split) throw new Error('splitCoins returned no result');
		return split;
	}

	// `--with-unpublished-dependencies` inlines DeepBook's `token` sub-package
	// under the parent's address, so DEEP type lives at deepbookPackageId.
	const deepCoinType = `${deepbookPackageId}::deep::DEEP`;
	const zeroDeep = tx.moveCall({
		target: '0x2::coin::zero',
		typeArguments: [deepCoinType],
	});

	const target =
		direction === 'base_to_quote'
			? `${deepbookPackageId}::pool::swap_exact_base_for_quote`
			: `${deepbookPackageId}::pool::swap_exact_quote_for_base`;
	const [outBase, outQuote, outDeep] = tx.moveCall({
		target,
		typeArguments: [baseCoinType, quoteCoinType],
		arguments: [
			tx.object(poolId),
			inCoin,
			zeroDeep,
			tx.pure.u64(minOut),
			tx.object(SUI_CLOCK_OBJECT_ID),
		],
	});
	if (!outBase || !outQuote || !outDeep) {
		throw new Error('swap returned unexpected result shape');
	}
	tx.transferObjects([outBase, outQuote, outDeep], sender);
	return tx;
}
