// Browser-side Walrus integration using the generated local network binding.
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { WalrusClient } from '@mysten/walrus';
import walrusWasmUrl from '@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url';

import { walrus } from '@generated/walrus.js';

const DEFAULT_EPOCHS = 1;

/** The per-network walrus binding (`walrus.forNetwork(network)`). */
type WalrusConfig = ReturnType<typeof walrus.forNetwork>;

let cachedClient: WalrusClient | null = null;
let cachedSuiClient: ClientWithCoreApi | null = null;
let cachedNetwork: string | null = null;

async function getSdkClient(
	suiClient: ClientWithCoreApi,
	network: string,
	walrusConfig: WalrusConfig,
): Promise<WalrusClient> {
	if (cachedClient !== null && cachedSuiClient === suiClient && cachedNetwork === network)
		return cachedClient;
	const client = new WalrusClient({
		suiClient,
		packageConfig: {
			systemObjectId: walrusConfig.packageConfig.systemObjectId,
			stakingPoolId: walrusConfig.packageConfig.stakingPoolId,
			...(walrusConfig.packageConfig.exchangeIds
				? { exchangeIds: [...walrusConfig.packageConfig.exchangeIds] }
				: {}),
		},
		storageNodeUrlScheme: 'https',
		wasmUrl: walrusWasmUrl,
	});
	cachedClient = client;
	cachedSuiClient = suiClient;
	cachedNetwork = network;
	return client;
}

const nestedString = (
	value: unknown,
	paths: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined => {
	for (const path of paths) {
		let cursor = value;
		for (const segment of path) {
			cursor =
				typeof cursor === 'object' && cursor !== null
					? (cursor as Record<string, unknown>)[segment]
					: undefined;
		}
		if (typeof cursor === 'string' && cursor.length > 0) return cursor;
	}
	return undefined;
};

const extractPublishResult = (response: unknown): StoreBlobResult => {
	const blobId = nestedString(response, [
		['newlyCreated', 'blobObject', 'blob_id'],
		['newlyCreated', 'blobObject', 'blobId'],
		['newlyCreated', 'blob_id'],
		['newlyCreated', 'blobId'],
		['blob_id'],
		['blobId'],
	]);
	const blobObjectId = nestedString(response, [
		['newlyCreated', 'blobObject', 'id'],
		['newlyCreated', 'blob_object', 'id'],
		['blobObject', 'id'],
		['blob_object', 'id'],
		['blobObjectId'],
	]);
	if (blobId !== undefined && blobObjectId !== undefined) return { blobId, blobObjectId };
	throw new Error(
		`Walrus publisher response did not include the created blob object: ${JSON.stringify(
			response,
		).slice(0, 1_000)}`,
	);
};

const requireLocalEndpoint = (
	walrusConfig: WalrusConfig,
	key: 'aggregatorUrl' | 'publisherUrl',
): string => {
	const value = walrusConfig[key];
	if (value === null) {
		throw new Error(`Local Walrus ${key} is disabled in this devstack`);
	}
	return value;
};

async function storeBlobThroughPublisher(args: {
	walrusConfig: WalrusConfig;
	signer: Signer;
	data: Uint8Array;
	epochs: number;
}): Promise<StoreBlobResult> {
	const url = new URL('/v1/blobs', requireLocalEndpoint(args.walrusConfig, 'publisherUrl'));
	url.searchParams.set('epochs', String(args.epochs));
	url.searchParams.set('deletable', 'true');
	url.searchParams.set('force', 'true');
	url.searchParams.set('send_object_to', args.signer.toSuiAddress());

	const response = await fetch(url, {
		method: 'PUT',
		body: new Uint8Array(args.data).buffer as ArrayBuffer,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Walrus publisher failed HTTP ${response.status}: ${text.slice(0, 1_000)}`);
	}
	return extractPublishResult(JSON.parse(text) as unknown);
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
	network: string;
	signer: Signer;
	data: Uint8Array;
	epochs?: number;
}): Promise<StoreBlobResult> {
	const walrusConfig = walrus.forNetwork(args.network);
	if (walrusConfig.mode === 'local') {
		return await storeBlobThroughPublisher({
			walrusConfig,
			signer: args.signer,
			data: args.data,
			epochs: args.epochs ?? DEFAULT_EPOCHS,
		});
	}

	const client = await getSdkClient(args.suiClient, args.network, walrusConfig);
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
	network: string;
	blobId: string;
}): Promise<Uint8Array> {
	const walrusConfig = walrus.forNetwork(args.network);
	if (walrusConfig.mode === 'local') {
		const response = await fetch(
			new URL(`/v1/blobs/${args.blobId}`, requireLocalEndpoint(walrusConfig, 'aggregatorUrl')),
		);
		if (!response.ok) {
			throw new Error(
				`Walrus aggregator failed HTTP ${response.status}: ${(await response.text()).slice(
					0,
					1_000,
				)}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	const client = await getSdkClient(args.suiClient, args.network, walrusConfig);
	return await client.readBlob({ blobId: args.blobId });
}

/**
 * Convert the URL-safe base64 blob id (the shape walrus's HTTP API and
 * SDK use) to the 32-byte representation that the Move `vector<u8>`
 * field stores.
 */
export function blobIdToBytes(blobId: string): Uint8Array {
	const padded = blobId.replace(/-/g, '+').replace(/_/g, '/');
	const pad = (4 - (padded.length % 4)) % 4;
	const b64 = padded + '='.repeat(pad);
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Inverse of {@link blobIdToBytes}. */
export function bytesToBlobId(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
