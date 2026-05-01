import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';

import { deployment } from '../generated/deployment.js';
import { Cap as CapStruct, File as FileStruct } from '../generated/sui/vault/vault.js';
import { bytesToHex } from './format.js';

export interface VaultFile {
	id: string;
	name: string;
	owner: string;
	encrypted: Uint8Array;
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
	const client = useCurrentClient();
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
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['vault', 'file', fileId],
		queryFn: async (): Promise<VaultFile | null> => {
			if (!fileId) return null;
			const result = await client.core.getObject({
				objectId: fileId,
				include: { content: true },
			});
			const parsed = FileStruct.parse(result.object.content);
			const encrypted = new Uint8Array(parsed.encrypted);
			const sealId = new Uint8Array(parsed.seal_id);
			return {
				id: fileId,
				name: parsed.name,
				owner: parsed.owner,
				encrypted,
				sealIdHex: bytesToHex(sealId),
			};
		},
		enabled: !!fileId,
	});
}
