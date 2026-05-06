// Generic dapp-kit-react sign-and-execute helper. Extracted from
// `examples/*/src/lib/queries.ts` where it had drifted into 4 near-byte-
// identical copies (notes/project-review.md). The function is not
// localnet-specific — it just wraps `dAppKit.signAndExecuteTransaction`
// with `useMutation` ergonomics + a `waitForTransaction` step so React
// Query invalidations fire after the indexer has the new state — but it
// lives here because every coin-aware example app re-derived it
// verbatim. Apps with custom mutation logic stay free to wrap it locally.

import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

export interface UseSignAndExecuteOptions {
	/** Query keys to invalidate on a successful tx. Each entry is passed
	 * to `qc.invalidateQueries({ queryKey })`. */
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

/**
 * Sign + execute a built `Transaction` via the connected wallet.
 * `mutateAsync` resolves only after `client.waitForTransaction` returns,
 * so any subsequent `invalidateQueries` you trigger sees the new chain
 * state.
 *
 *   const { mutateAsync } = useSignAndExecute({
 *     invalidateKeys: [['arena']],
 *   });
 *   const result = await mutateAsync(tx);   // { digest }
 */
/** True when `result` looks like the failed-transaction shape from
 * `dAppKit.signAndExecuteTransaction`. The shape is documented in
 * `@mysten/dapp-kit-core` but its type doesn't expose it via a
 * discriminated union; this guard pins the runtime contract instead of
 * casting `result` at the read site. */
function isFailedTransaction(
	result: unknown,
): result is { FailedTransaction: { status?: { error?: string | null } } } {
	if (typeof result !== 'object' || result === null) return false;
	if (!('FailedTransaction' in result)) return false;
	const ft = (result as { FailedTransaction?: unknown }).FailedTransaction;
	return typeof ft === 'object' && ft !== null;
}

/** True when `result` carries the success-shape `{ Transaction: { digest } }`. */
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

/** True when `client` exposes `waitForTransaction({digest})` as a method.
 * The dapp-kit-react `useCurrentClient<TDAppKit>()` typing widens
 * `client.core` to `any` across module-augmentation boundaries (see
 * `notes/friction.md`); this guard sidesteps the widening at the read
 * site instead of casting. */
function hasWaitForTransaction(
	client: unknown,
): client is { waitForTransaction: (a: { digest: string }) => Promise<unknown> } {
	if (typeof client !== 'object' || client === null) return false;
	if (!('waitForTransaction' in client)) return false;
	return typeof (client as { waitForTransaction?: unknown }).waitForTransaction === 'function';
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
			// Method-call form preserves `this` so the SDK's internal
			// `this.core.X` access works. Destructuring
			// `client.waitForTransaction` to a local would lose `this`
			// and trip a runtime TypeError.
			if (hasWaitForTransaction(client) && tx.digest.length > 0) {
				await client.waitForTransaction({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}
