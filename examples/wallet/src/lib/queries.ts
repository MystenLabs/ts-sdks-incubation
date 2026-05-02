import { bindPackage, useDevstackManifest } from '@mysten-incubation/devstack/react';
import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

/**
 * Bind a codegen module against the live `packageId` from the manifest
 * for `name`. Returns the same module with `'@local-pkg/<name>'`
 * placeholders substituted by the live id at builder-call time.
 *
 * Production version (mainnet/testnet) reads the id from a constants
 * file instead of the manifest — same call shape downstream.
 */
export function usePackage<M extends Record<string, unknown>>(module: M, name: string): M {
	const manifest = useDevstackManifest();
	const packages = manifest.registry.packages as Array<{ name: string; packageId: string }>;
	const id = packages.find((p) => p.name === name)?.packageId ?? '0x0';
	return useMemo(() => bindPackage(module, id), [module, id]) as M;
}

// Native SUI coin type — the constant lives at sui-framework address 0x2.
export const SUI_COIN_TYPE = '0x2::sui::SUI';

// FRICTION: this hook + invalidation pattern is a near-duplicate of
// examples/token-studio/src/lib/queries.ts. Phase 2 should ship `useCoinBalance`
// and `useSignAndExecute` in a shared package — every coin-aware app will
// write these.
//
// Polls every 2s so balances stay current after txs that didn't go through
// `useDevstackSignAndExecute` (e.g. the dev-wallet's Faucet panel) and
// therefore didn't invalidate the query keys.
const BALANCE_POLL_MS = 2_000;

export function useCoinBalance(address: string | undefined, coinType: string) {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['balance', address, coinType],
		queryFn: async () => {
			if (!address) return null;
			const result = await client.core.getBalance({ owner: address, coinType });
			return result.balance;
		},
		enabled: !!address,
		refetchInterval: BALANCE_POLL_MS,
	});
}

export const useSuiBalance = (address: string | undefined) =>
	useCoinBalance(address, SUI_COIN_TYPE);

export function useInvalidateBalances() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: ['balance'] });
	};
}

export interface UseSignAndExecuteOptions {
	/** Query keys to invalidate on a successful tx. */
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

/**
 * App-local sign+execute helper. Wraps `dAppKit.signAndExecuteTransaction`
 * (the documented dapp-kit-react entry) with `useMutation` ergonomics +
 * a `waitForTransaction` step so React Query invalidations fire after
 * the indexer has the new state.
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
				const status = (result.FailedTransaction as { status?: { error?: string | null } }).status;
				throw new Error(status?.error ?? 'transaction failed');
			}
			const tx = (result as { Transaction?: { digest: string } }).Transaction;
			if (!tx) throw new Error('signAndExecuteTransaction: missing Transaction in result');
			return tx;
		},
		onSuccess: async (tx) => {
			const wft = (
				client as { waitForTransaction?: (a: { digest: string }) => Promise<unknown> }
			).waitForTransaction;
			if (typeof wft === 'function' && tx.digest.length > 0) {
				await wft({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}
