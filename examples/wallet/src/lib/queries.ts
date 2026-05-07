import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
} from '@tanstack/react-query';

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

// Native SUI coin type — the constant lives at sui-framework address 0x2.
export const SUI_COIN_TYPE = '0x2::sui::SUI';

// Polls every 2s so balances stay current after txs that didn't go through
// `useSignAndExecute` (e.g. the dev-wallet's Faucet panel) and therefore
// didn't invalidate the query keys.
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
