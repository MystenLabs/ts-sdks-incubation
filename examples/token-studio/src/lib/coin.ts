import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { deployment } from '../generated/deployment.js';

export const MANAGED_COIN_TYPE = deployment.managedCoinType;
export const TREASURY_CAP_ID = deployment.treasuryCapId;
export const COIN_DECIMALS = 6;

/**
 * Build a transaction that transfers `amount` (raw units) of STUDIO to `recipient`.
 * Resolves the sender's STUDIO coins, merges them as needed, and splits out the
 * exact amount.
 */
export async function buildTransferTx(args: {
	client: ClientWithCoreApi;
	sender: string;
	amount: bigint;
	recipient: string;
}): Promise<Transaction> {
	const { client, sender, amount, recipient } = args;
	const { objects } = await client.core.listCoins({
		owner: sender,
		coinType: MANAGED_COIN_TYPE,
	});
	if (objects.length === 0) throw new Error('No STUDIO coins owned by this account');

	const total = objects.reduce((acc, c) => acc + BigInt(c.balance), 0n);
	if (total < amount) {
		throw new Error(`Insufficient STUDIO: have ${total}, need ${amount}`);
	}

	const tx = new Transaction();
	const [primary, ...rest] = objects;
	if (!primary) throw new Error('No STUDIO coins owned by this account');
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

export function parseStudioAmount(input: string): bigint {
	const trimmed = input.trim();
	if (!trimmed) return 0n;
	if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) {
		throw new Error('Enter a non-negative number with up to 6 decimal places');
	}
	const [whole, frac = ''] = trimmed.split('.');
	const padded = (frac + '0'.repeat(COIN_DECIMALS)).slice(0, COIN_DECIMALS);
	return BigInt(whole ?? '0') * 10n ** BigInt(COIN_DECIMALS) + BigInt(padded || '0');
}

export function formatStudio(raw: bigint | string | number, fractionDigits = 2): string {
	const big = typeof raw === 'bigint' ? raw : BigInt(raw);
	const divisor = 10n ** BigInt(COIN_DECIMALS);
	const whole = big / divisor;
	const frac = big % divisor;
	const fracStr = frac.toString().padStart(COIN_DECIMALS, '0').slice(0, fractionDigits);
	return `${whole.toString()}.${fracStr}`;
}

export function shortAddress(address: string, head = 6, tail = 4): string {
	if (address.length <= head + tail + 2) return address;
	return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}

export function labelFor(address: string): string | null {
	for (const [name, addr] of Object.entries(deployment.accounts)) {
		if (addr === address) return name;
	}
	return null;
}
