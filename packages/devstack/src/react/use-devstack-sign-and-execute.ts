// `useDevstackSignAndExecute()` — bakes in the four-app duplicated
// pattern (mutation → wait-for-tx → invalidate query namespace).
//
// Mirrors arena's `lib/queries.ts:useSignAndExecute` (the comment there
// literally calls it "fourth copy of this pattern"). Apps that previously
// rebuilt this hook now consume it from the React adapter.

import { useCurrentClient } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

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
	// dapp-kit's React adapter exposes the active signer-shaped object
	// via the global `dAppKit` registered through module augmentation.
	// The actual `signAndExecuteTransaction` lives on dAppKit. To stay
	// dependency-free at this layer, accept either a manually-bound
	// `dAppKit` from the app context OR rely on the user to pass a
	// `Transaction` and call `.signAndExecuteTransaction` themselves
	// via `dAppKit`. The four apps already pass through dAppKit; mirror
	// that surface by exposing a hook that delegates the actual sign+
	// execute to a global `dAppKit.signAndExecuteTransaction` lookup.
	const signAndExecute = lookupSignAndExecute();
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

/** Resolve the `signAndExecuteTransaction` callable from the
 * app-augmented `Register['dAppKit']` global. The four example apps all
 * register a singleton `dAppKit` via dapp-kit's module augmentation;
 * accessing it via the global registry sidesteps a peer-dep on the
 * app's specific dapp-kit instance. Throws if no dAppKit was set up. */
function lookupSignAndExecute(): SignAndExecuteFn {
	// `@mysten/dapp-kit-react`'s React state isn't directly exposed
	// here — apps register their dAppKit via module augmentation and
	// use `useCurrentClient()` etc. As a pragmatic shim, expect the
	// app to attach `dAppKit` to `globalThis.__devstackDAppKit__`
	// during setup (the helper `createDevstackDappKit` does this in G2).
	const fn = (
		globalThis as { __devstackDAppKit__?: { signAndExecuteTransaction: SignAndExecuteFn } }
	).__devstackDAppKit__?.signAndExecuteTransaction;
	if (typeof fn !== 'function') {
		throw new Error(
			'useDevstackSignAndExecute: no dAppKit registered. Use `createDevstackDappKit({...})` ' +
				'from `@mysten-incubation/devstack/react` so the hook can locate the active wallet.',
		);
	}
	return fn;
}
