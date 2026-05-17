import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
} from '@tanstack/react-query';

import { deployment } from './deployment.js';
import { Cap as CapStruct, File as FileStruct } from '../generated/bindings/vault/vault.js';
import { bytesToHex } from './format.js';
import { bytesToBlobId } from './walrus.js';

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

export interface VaultFile {
	id: string;
	name: string;
	owner: string;
	/** URL-safe base64 walrus blob id (the shape `walrus daemon` accepts). */
	blobId: string;
	sealIdHex: string;
}

export interface VaultCap {
	id: string;
	fileId: string;
}

/**
 * Fetch every Cap object owned by `address`. listOwnedObjects + a type
 * filter on `<vault-pkg>::vault::Cap` returns one page (a few entries
 * suffices for the demo; pagination is future work).
 */
export function useOwnedCaps(address: string | undefined) {
	const client: SuiGrpcClient = useCurrentClient();
	return useQuery({
		queryKey: ['vault', 'caps', address, deployment.vaultPackageId],
		queryFn: async (): Promise<VaultCap[]> => {
			if (!address || !deployment.vaultPackageId) return [];
			const capType = `${deployment.vaultPackageId}::vault::Cap`;
			const page = await client.core.listOwnedObjects({
				owner: address,
				type: capType,
				include: { content: true },
			});
			return page.objects.map((obj) => {
				const parsed = CapStruct.parse(obj.content);
				return { id: obj.objectId, fileId: parsed.file_id };
			});
		},
		enabled: !!address && !!deployment.vaultPackageId,
	});
}

/**
 * Fetch a single File shared object by id. Used by the file list to
 * resolve each Cap's `file_id` to its underlying File metadata + bytes.
 */
export function useFile(fileId: string | undefined) {
	const client: SuiGrpcClient = useCurrentClient();
	return useQuery({
		queryKey: ['vault', 'file', fileId],
		queryFn: async (): Promise<VaultFile | null> => {
			if (!fileId) return null;
			const result = await client.core.getObject({
				objectId: fileId,
				include: { content: true },
			});
			const parsed = FileStruct.parse(result.object.content);
			const blobIdBytes = new Uint8Array(parsed.blob_id);
			const sealId = new Uint8Array(parsed.seal_id);
			return {
				id: fileId,
				name: parsed.name,
				owner: parsed.owner,
				blobId: bytesToBlobId(blobIdBytes),
				sealIdHex: bytesToHex(sealId),
			};
		},
		enabled: !!fileId,
	});
}
