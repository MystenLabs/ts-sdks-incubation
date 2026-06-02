import { Transaction } from '@mysten/sui/transactions';

import * as vault from '@generated/bindings/vault/vault.js';

// The vault bindings emit `options.package ?? 'vault'`. We rely on that
// binding default and let the grpc client's MVR overrides
// (see `mvrOverrides` in `dapp-kit.ts`) resolve `'vault'` to the deployed
// package id at tx-build time, so no concrete package id is threaded here.

export function buildVaultUploadTransaction(input: {
	readonly name: string;
	readonly blobId: Uint8Array | ReadonlyArray<number>;
	readonly sealId: Uint8Array | ReadonlyArray<number>;
}): Transaction {
	const tx = new Transaction();
	tx.add(
		vault.uploadEntry({
			arguments: [input.name, Array.from(input.blobId), Array.from(input.sealId)],
		}),
	);
	return tx;
}

export function buildVaultGrantTransaction(input: {
	readonly fileId: string;
	readonly recipient: string;
}): Transaction {
	const tx = new Transaction();
	tx.add(
		vault.grantEntry({
			arguments: [input.fileId, input.recipient],
		}),
	);
	return tx;
}
