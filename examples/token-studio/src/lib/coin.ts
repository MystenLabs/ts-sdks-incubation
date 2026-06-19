import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

// Pure amount/format helpers live in `amount.ts` (no @generated dependency,
// unit-tested without a stack); re-exported here so callers keep one import site.
export { COIN_DECIMALS, formatStudio, parseStudioAmount, shortAddress } from './amount.js';

/**
 * Build a transaction that transfers `amount` (raw units) of the STUDIO coin
 * (`coinType`) to `recipient`. The `coinType` is per-network and must be passed
 * by the caller from `useDeployment().managedCoinType` so the tx follows the
 * dapp-kit-selected network. Resolves the sender's coins, merges them as needed,
 * and splits out the exact amount.
 */
export async function buildTransferTx(args: {
	client: ClientWithCoreApi;
	sender: string;
	amount: bigint;
	recipient: string;
	coinType: string;
}): Promise<Transaction> {
	const { client, sender, amount, recipient, coinType } = args;
	const { objects } = await client.core.listCoins({
		owner: sender,
		coinType,
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
