import { Transaction } from '@mysten/sui/transactions';

import * as vault from '../generated/bindings/vault/vault.js';

export function buildVaultUploadTransaction(input: {
	readonly packageId: string;
	readonly name: string;
	readonly blobId: Uint8Array | ReadonlyArray<number>;
	readonly sealId: Uint8Array | ReadonlyArray<number>;
}): Transaction {
	const tx = new Transaction();
	tx.add(
		vault.uploadEntry({
			package: input.packageId,
			arguments: [input.name, Array.from(input.blobId), Array.from(input.sealId)],
		}),
	);
	return tx;
}

export function buildVaultGrantTransaction(input: {
	readonly packageId: string;
	readonly fileId: string;
	readonly recipient: string;
}): Transaction {
	const tx = new Transaction();
	tx.add(
		vault.grantEntry({
			package: input.packageId,
			arguments: [input.fileId, input.recipient],
		}),
	);
	return tx;
}
