import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
} from '@tanstack/react-query';

import { deployment } from './deployment.js';
import { MANAGED_COIN_TYPE } from './coin.js';

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

// Polls so balance + supply stay current after txs that didn't go through
// `useDevstackSignAndExecute` (e.g. the dev-wallet's Faucet panel mint).
const COIN_POLL_MS = 2_000;

export function useCoinMetadata() {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['coinMetadata', MANAGED_COIN_TYPE],
		queryFn: () => client.core.getCoinMetadata({ coinType: MANAGED_COIN_TYPE }),
	});
}

/**
 * Read total supply from the TreasuryCap object's JSON representation.
 * Sui's gRPC core API doesn't expose `getTotalSupply` directly, so we
 * read the cap object and parse the supply field out of it.
 */
export function useTotalSupply() {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['totalSupply', deployment.treasuryCapId],
		queryFn: async () => {
			const { object } = await client.core.getObject({
				objectId: deployment.treasuryCapId,
				include: { json: true },
			});
			const json = object.json as { total_supply?: { value?: string } } | undefined;
			return BigInt(json?.total_supply?.value ?? '0');
		},
		refetchInterval: COIN_POLL_MS,
	});
}

export function useCoinBalance(address: string | undefined) {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['balance', address, MANAGED_COIN_TYPE],
		queryFn: async () => {
			if (!address) return null;
			const result = await client.core.getBalance({
				owner: address,
				coinType: MANAGED_COIN_TYPE,
			});
			return result.balance;
		},
		enabled: !!address,
		refetchInterval: COIN_POLL_MS,
	});
}

/**
 * Returns a callback that invalidates every read of the coin's state — call
 * after a successful mint/transfer so balances and supply re-fetch.
 */
export function useInvalidateCoinReads() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) });
	};
}
