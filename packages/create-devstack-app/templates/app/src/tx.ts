// Pure transaction-result helpers — no chain, no codegen, no devstack.
// Unit-tested in `tx.test.ts` (runs under `pnpm test`, boots nothing).

import type { SuiClientTypes } from '@mysten/sui/client';

/** Unwrap an executed-transaction result (dapp-kit's `signAndExecuteTransaction`
 *  and the SDK client's both return this union): throw on execution failure,
 *  otherwise return the digest plus the id of the object the tx created. */
export function executedTx(result: SuiClientTypes.TransactionResult<{ effects: true }>): {
	digest: string;
	createdId: string | undefined;
} {
	if (result.$kind !== 'Transaction') {
		throw new Error(result.FailedTransaction.status.error?.message ?? 'transaction failed');
	}
	const created = result.Transaction.effects.changedObjects.find(
		(change) => change.idOperation === 'Created',
	);
	return { digest: result.Transaction.digest, createdId: created?.objectId };
}
