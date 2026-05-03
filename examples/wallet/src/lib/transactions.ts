import { Transaction } from '@mysten/sui/transactions';

// Sui's system Clock object — required by DeepBook entry functions that use
// timestamps for matching (passed by reference, not consumed).
const SUI_CLOCK_OBJECT_ID = '0x6';

/**
 * Build a transaction that sends `amount` (raw base units) of `coinType` to
 * `recipient`. Uses `tx.coin({ useGasCoin: false })` which the SDK resolves
 * via address-balance withdrawal when available, falling back to coin
 * objects — so the same builder works whether the signing path uses
 * coin-mode gas or address-balance gas.
 */
export async function buildSendTx(args: {
	coinType: string;
	amount: bigint;
	recipient: string;
}): Promise<Transaction> {
	const { coinType, amount, recipient } = args;
	const tx = new Transaction();
	const coin = tx.coin({ balance: amount, type: coinType, useGasCoin: false });
	tx.transferObjects([coin], recipient);
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

	// `tx.coin({ useGasCoin: false })` resolves via address-balance withdrawal
	// when available, owned coin objects otherwise. Works in both coin-mode
	// gas and address-balance gas paths.
	const inCoin = tx.coin({ balance: amountIn, type: inCoinType, useGasCoin: false });

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
