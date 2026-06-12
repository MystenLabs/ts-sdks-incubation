// Counter flows over the generated Move bindings.
//
// Binding names come from devstack's Move codegen (snake_case Move fn →
// camelCase TS export):
//   - `counter::create_and_share` → `createAndShare`
//   - `counter::increment_entry`  → `incrementEntry`
//   - struct `Counter`            → `Counter` (with `.get({ client, objectId })`)
//
// No package id is threaded here: the generated builders default `package`
// to `@local/counter`, which the client's MVR overrides (see `dapp-kit.ts`)
// resolve to the active network's deployed id at tx-build time.

import type { ClientWithCoreApi, SuiClientTypes } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { Counter, createAndShare, incrementEntry } from '@generated/bindings/counter/counter.js';

/** Build a tx that creates + shares a fresh `Counter` (starts at 0). */
export function createCounterTx(): Transaction {
	const tx = new Transaction();
	createAndShare()(tx);
	return tx;
}

/** Build a tx that increments the shared `Counter` at `counterId` by one. */
export function incrementTx(counterId: string): Transaction {
	const tx = new Transaction();
	incrementEntry({ arguments: { counter: counterId } })(tx);
	return tx;
}

/** Read the current value of the shared `Counter` at `objectId`. */
export async function readCounter(client: ClientWithCoreApi, objectId: string): Promise<bigint> {
	const counter = await Counter.get({ client, objectId });
	return BigInt(counter.json.value);
}

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
