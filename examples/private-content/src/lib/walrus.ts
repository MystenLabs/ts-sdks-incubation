// Browser-side walrus integration. Builds a vanilla `WalrusClient`
// against the localnet walrus package, sourcing the system + staking
// object ids from the generated `captured.ts` (populated by the
// `Walrus({...})` plugin's register step). On testnet/mainnet drop
// `localnetWalrusOptions` from the spread and configure
// `WalrusClient` against the real network.

// Import from the `/browser` subpath: the main `@mysten-incubation/devstack`
// barrel pulls in node-only modules (engine/identity uses `node:path` +
// `node:fs`), and Vite's externalized-node-module proxy throws on every
// property access at module init — page blanks, no React render. The
// `/browser` subpath re-exports only pure helpers.
import { getWalrusCaptured, localnetWalrusOptions } from '@mysten-incubation/devstack/browser';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { WalrusClient } from '@mysten/walrus';
// `?url` lets Vite serve the wasm with the right MIME type and a stable URL,
// rather than the SDK's default fetch from a path that hits the SPA fallback
// and returns `index.html`. Pattern matches the walrus SDK README.
import walrusWasmUrl from '@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url';

import { captured } from '../generated/captured.js';

const walrusOpts = localnetWalrusOptions(getWalrusCaptured(captured));

const DEFAULT_EPOCHS = 1;

let cachedClient: WalrusClient | null = null;
let cachedSuiClient: ClientWithCoreApi | null = null;

async function getClient(suiClient: ClientWithCoreApi): Promise<WalrusClient> {
	if (cachedClient !== null && cachedSuiClient === suiClient) return cachedClient;
	const client = new WalrusClient({
		suiClient,
		...walrusOpts,
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
