import { Transaction } from '@mysten/sui/transactions';

/**
 * Build a transaction that sends `amount` (raw base units) of `coinType` to
 * `recipient`. `useGasCoin: true` is the right default for SUI sends —
 * the SDK splits from the gas coin, leaving the rest of the sender's SUI
 * coins untouched for gas selection. With `useGasCoin: false`, the SDK's
 * resolver merges every owned SUI coin into a single source for the send,
 * leaving the gas-coin selector with nothing and failing with "No valid
 * gas coins found" on accounts that don't have an address-balance
 * deposit. The flag is a no-op for non-SUI coins.
 */
export async function buildSendTx(args: {
	coinType: string;
	amount: bigint;
	recipient: string;
}): Promise<Transaction> {
	const { coinType, amount, recipient } = args;
	const tx = new Transaction();
	const coin = tx.coin({ balance: amount, type: coinType, useGasCoin: true });
	tx.transferObjects([coin], recipient);
	return tx;
}
