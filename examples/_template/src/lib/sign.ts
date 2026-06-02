// Shared transaction signing hook.
//
// Wraps dapp-kit's `signAndExecuteTransaction` with the robust result
// handling every panel needs: it normalizes the `FailedTransaction` /
// `Transaction` result union into a thrown error or a `{ digest }`, waits
// for the digest to be indexed (so a follow-up read sees the new state),
// and invalidates any react-query keys the caller passes.

import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

export interface UseSignAndExecuteOptions {
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

function isFailedTransaction(
	result: unknown,
): result is { FailedTransaction: { status?: { error?: string | null } } } {
	if (typeof result !== 'object' || result === null) return false;
	if (!('FailedTransaction' in result)) return false;
	const ft = (result as { FailedTransaction?: unknown }).FailedTransaction;
	return typeof ft === 'object' && ft !== null;
}

function hasTransaction(result: unknown): result is { Transaction: { digest: string } } {
	if (typeof result !== 'object' || result === null) return false;
	if (!('Transaction' in result)) return false;
	const tx = (result as { Transaction?: unknown }).Transaction;
	return (
		typeof tx === 'object' &&
		tx !== null &&
		'digest' in tx &&
		typeof (tx as { digest?: unknown }).digest === 'string'
	);
}

function hasWaitForTransaction(
	client: unknown,
): client is { waitForTransaction: (a: { digest: string }) => Promise<unknown> } {
	if (typeof client !== 'object' || client === null) return false;
	if (!('waitForTransaction' in client)) return false;
	return typeof (client as { waitForTransaction?: unknown }).waitForTransaction === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCreatedObject(change: unknown): change is { readonly objectId: string } {
	if (!isRecord(change) || typeof change.objectId !== 'string') return false;
	const operation = change.idOperation;
	return (
		operation === 'Created' ||
		(isRecord(operation) && (operation.$kind === 'Created' || 'Created' in operation))
	);
}

/**
 * Pull the first created object id out of a finalized transaction's
 * effects. `result` is whatever `client.waitForTransaction({ digest,
 * include: { effects: true } })` returns — shape-checked structurally so
 * this survives minor client-version drift.
 */
export function firstCreatedObjectId(result: unknown): string | null {
	const tx = isRecord(result) && isRecord(result.Transaction) ? result.Transaction : result;
	const effects = isRecord(tx) && isRecord(tx.effects) ? tx.effects : undefined;
	const changed = effects?.changedObjects;
	if (!Array.isArray(changed)) return null;
	const created = changed.find(isCreatedObject);
	return created ? created.objectId : null;
}

/**
 * Wait for `digest` to be indexed and return the first object it created.
 * `client` is the dapp-kit current client (structural `waitForTransaction`).
 */
export async function waitForCreatedObjectId(
	client: unknown,
	digest: string,
): Promise<string | null> {
	if (typeof client !== 'object' || client === null || !('waitForTransaction' in client)) {
		return null;
	}
	const finalized = await (
		client as {
			waitForTransaction: (a: {
				digest: string;
				include?: { effects?: boolean };
			}) => Promise<unknown>;
		}
	).waitForTransaction({ digest, include: { effects: true } });
	return firstCreatedObjectId(finalized);
}

export function useSignAndExecute(
	options: UseSignAndExecuteOptions = {},
): UseMutationResult<{ digest: string }, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const qc = useQueryClient();
	return useMutation<{ digest: string }, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if (isFailedTransaction(result)) {
				throw new Error(result.FailedTransaction.status?.error ?? 'transaction failed');
			}
			if (!hasTransaction(result)) {
				throw new Error('signAndExecuteTransaction: missing Transaction in result');
			}
			return result.Transaction;
		},
		onSuccess: async (tx) => {
			if (hasWaitForTransaction(client) && tx.digest.length > 0) {
				await client.waitForTransaction({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}
