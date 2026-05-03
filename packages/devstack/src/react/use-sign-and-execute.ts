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
export function useSignAndExecute(
	options: UseSignAndExecuteOptions = {},
): UseMutationResult<{ digest: string }, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const qc = useQueryClient();
	return useMutation<{ digest: string }, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if ('FailedTransaction' in result && result.FailedTransaction) {
				const status = (result.FailedTransaction as { status?: { error?: string | null } })
					.status;
				throw new Error(status?.error ?? 'transaction failed');
			}
			const tx = (result as { Transaction?: { digest: string } }).Transaction;
			if (!tx) throw new Error('signAndExecuteTransaction: missing Transaction in result');
			return tx;
		},
		onSuccess: async (tx) => {
			// Method-call form preserves `this` so the SDK's internal
			// `this.core.X` access works. Destructuring
			// `client.waitForTransaction` to a local would lose `this`
			// and trip a runtime TypeError.
			const c = client as {
				waitForTransaction?: (a: { digest: string }) => Promise<unknown>;
			};
			if (typeof c.waitForTransaction === 'function' && tx.digest.length > 0) {
				await c.waitForTransaction({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}
