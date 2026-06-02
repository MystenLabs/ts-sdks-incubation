// Browser-side Walrus integration over the generated `walrus` binding.
//
// Harvested from examples/private-content (already on the new generated
// shape): `walrus` from `@generated/walrus.js` is a single WalrusBindings
// (not name-keyed). store/read a blob through the dev-wallet-backed
// signer.

import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { WalrusClient } from '@mysten/walrus';
import walrusWasmUrl from '@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url';

import { walrus } from '@generated/walrus.js';

const DEFAULT_EPOCHS = 1;

let cachedClient: WalrusClient | null = null;
let cachedSuiClient: ClientWithCoreApi | null = null;

async function getClient(suiClient: ClientWithCoreApi): Promise<WalrusClient> {
	if (cachedClient !== null && cachedSuiClient === suiClient) return cachedClient;
	const client = new WalrusClient({
		suiClient,
		packageConfig: {
			systemObjectId: walrus.packageConfig.systemObjectId,
			stakingPoolId: walrus.packageConfig.stakingPoolId,
			...(walrus.packageConfig.exchangeIds
				? { exchangeIds: [...walrus.packageConfig.exchangeIds] }
				: {}),
		},
		storageNodeUrlScheme: walrus.mode === 'local' ? 'http' : 'https',
		wasmUrl: walrusWasmUrl,
	});
	cachedClient = client;
	cachedSuiClient = suiClient;
	return client;
}

export interface StoreBlobResult {
	blobId: string;
	blobObjectId: string;
}

/**
 * Encode `data`, register a Blob object on chain (signed by `signer`),
 * upload slivers to the storage committee, and certify. Returns the
 * SDK-assigned blob id (URL-safe base64) plus the on-chain Blob object id.
 */
export async function storeBlob(args: {
	suiClient: ClientWithCoreApi;
	signer: Signer;
	data: Uint8Array;
	epochs?: number;
}): Promise<StoreBlobResult> {
	const client = await getClient(args.suiClient);
	const result = await client.writeBlob({
		blob: args.data,
		signer: args.signer,
		epochs: args.epochs ?? DEFAULT_EPOCHS,
		deletable: true,
	});
	return {
		blobId: result.blobId,
		blobObjectId: result.blobObject.id,
	};
}

/**
 * Fetch a previously-stored blob by id. The SDK reads slivers from the
 * storage committee (via the host-port proxy installed by devstack) and
 * reassembles the original bytes.
 */
export async function readBlob(args: {
	suiClient: ClientWithCoreApi;
	blobId: string;
}): Promise<Uint8Array> {
	const client = await getClient(args.suiClient);
	return await client.readBlob({ blobId: args.blobId });
}
