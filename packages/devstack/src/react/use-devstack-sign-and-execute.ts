// `useDevstackSignAndExecute()` — bakes in the four-app duplicated
// pattern (mutation → wait-for-tx → invalidate query namespace).
//
// Mirrors arena's `lib/queries.ts:useSignAndExecute` (the comment there
// literally calls it "fourth copy of this pattern"). Apps that previously
// rebuilt this hook now consume it from the React adapter.

import { useCurrentClient } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { useDevstackContext } from './provider.js';

export interface UseDevstackSignAndExecuteOptions {
	/** Query keys to invalidate on a successful tx. Default: no
	 * invalidation. Pass an array of top-level query keys (matching the
	 * app's `queryKey: ['arena', ...]` shape) to refresh dependent
	 * reads.
	 */
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

interface SignAndExecuteResult {
	digest?: string;
	[key: string]: unknown;
}

interface SignAndExecuteFn {
	(args: { transaction: Transaction }): Promise<SignAndExecuteResult>;
}

/**
 * Returns the `useMutation` hook that the four example apps rebuild
 * verbatim: takes a `Transaction`, signs via the active dapp-kit
 * wallet, waits for the tx digest to land, and invalidates any query
 * keys passed in `options.invalidateKeys`.
 *
 * Requires `@mysten/dapp-kit-react`'s `<SuiClientProvider>` and
 * `<WalletProvider>` ancestors plus `@tanstack/react-query`'s
 * `<QueryClientProvider>` — same shape every app already wires.
 */
export function useDevstackSignAndExecute(
	options: UseDevstackSignAndExecuteOptions = {},
): UseMutationResult<SignAndExecuteResult, Error, Transaction> {
	const baseClient = useCurrentClient();
	// The unaugmented dapp-kit-react `useCurrentClient` returns
	// `ClientWithCoreApi`, which doesn't statically surface
	// `waitForTransaction`. Apps register their own dAppKit shape via
	// module augmentation, which is where the runtime method comes from.
	// We probe at call time and fall back to skipping the wait when the
	// active client doesn't have it (e.g. test harnesses with a stubbed
	// dapp-kit). Better than a silent `undefined.()` throw inside the
	// mutation.
	const maybeClient = baseClient as unknown as {
		waitForTransaction?: (args: { digest: string }) => Promise<unknown>;
	};
	const qc = useQueryClient();
	const { dAppKit } = useDevstackContext();
	const signAndExecute = lookupSignAndExecute(dAppKit);
	return useMutation<SignAndExecuteResult, Error, Transaction>({
		mutationFn: async (transaction) => signAndExecute({ transaction }),
		onSuccess: async (result) => {
			const digest =
				typeof result === 'object' && result !== null
					? (result.digest ??
						(result as { Transaction?: { digest?: string } }).Transaction?.digest ??
						(result as { FailedTransaction?: { digest?: string } }).FailedTransaction?.digest)
					: undefined;
			if (typeof digest === 'string' && digest.length > 0) {
				if (typeof maybeClient.waitForTransaction === 'function') {
					await maybeClient.waitForTransaction({ digest });
				}
				// else: silently skip the wait — caller's invalidation may
				// race the indexer's commit, but the alternative is throwing
				// inside a mutation success handler, which is worse.
			}
			// Await invalidation so isPending stays true until refetches
			// complete — apps that gate spinners on isPending get the right
			// behavior without an explicit invalidate() call.
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}

/** Resolve `signAndExecuteTransaction` from the dAppKit threaded
 * through `<DevstackProvider dAppKit={...}>`. Falls back to the legacy
 * `globalThis.__devstackDAppKit__` slot for back-compat (apps written
 * before the Provider gained a `dAppKit` prop), with a one-time
 * deprecation note. */
function lookupSignAndExecute(fromContext: unknown): SignAndExecuteFn {
	const ctxFn = (fromContext as { signAndExecuteTransaction?: SignAndExecuteFn } | undefined)
		?.signAndExecuteTransaction;
	if (typeof ctxFn === 'function') return ctxFn;

	const globalFn = (
		globalThis as { __devstackDAppKit__?: { signAndExecuteTransaction: SignAndExecuteFn } }
	).__devstackDAppKit__?.signAndExecuteTransaction;
	if (typeof globalFn === 'function') {
		// eslint-disable-next-line no-console
		console.warn(
			'useDevstackSignAndExecute: falling back to globalThis.__devstackDAppKit__. ' +
				'Pass `dAppKit` to <DevstackProvider> so the hook reads from React context — ' +
				'the global slot is deprecated and breaks when two apps share a realm.',
		);
		return globalFn;
	}
	throw new Error(
		'useDevstackSignAndExecute: no dAppKit available. Pass it to ' +
			'<DevstackProvider dAppKit={dAppKit}> so the hook can read it from context.',
	);
}
