import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Effect } from 'effect';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	makeWalrusAggregatorListener,
	makeWalrusPublisherListener,
} from '../../../src/plugins/walrus/http-services.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/index.ts';

const openServers: Server[] = [];

const listen = async (
	listener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> => {
	const server = createServer(listener);
	await new Promise<void>((resolve, reject) => {
		const onError = (cause: Error) => reject(cause);
		server.once('error', onError);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', onError);
			resolve();
		});
	});
	openServers.push(server);
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
	const servers = openServers.splice(0);
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((cause) => {
						if (cause) reject(cause);
						else resolve();
					});
				}),
		),
	);
});

const text = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('utf8');

interface WriteBlobCall {
	readonly blob: Uint8Array;
	readonly deletable: boolean;
	readonly epochs: number;
	readonly owner?: string;
}

describe('walrus local HTTP services', () => {
	it('reads blobs through a single aggregator endpoint and caches successful reads', async () => {
		const readBlob = vi.fn(async ({ blobId }: { readonly blobId: string }) =>
			new TextEncoder().encode(`blob:${blobId}`),
		);
		const baseUrl = await listen(
			makeWalrusAggregatorListener({
				readBlob,
			}),
		);

		const first = await fetch(`${baseUrl}/v1/blobs/blob%201`);
		const second = await fetch(`${baseUrl}/v1/blobs/blob%201`);

		expect(first.status).toBe(200);
		expect(text(await first.arrayBuffer())).toBe('blob:blob 1');
		expect(second.status).toBe(200);
		expect(text(await second.arrayBuffer())).toBe('blob:blob 1');
		expect(readBlob).toHaveBeenCalledTimes(1);
	});

	it('publishes blobs through one publisher endpoint using the local publisher signer', async () => {
		const signer = Ed25519Keypair.generate();
		const storageCost = vi.fn(async () => ({
			storageCost: 7n,
			writeCost: 11n,
			totalCost: 18n,
		}));
		const writeBlob = vi.fn(async (_options: WriteBlobCall) => ({
			blobId: 'test-blob',
			blobObject: {
				id: '0xblob',
				registered_epoch: 1,
				blob_id: 'test-blob',
				size: '5',
				encoding_type: 0,
				certified_epoch: null,
				storage: {
					id: '0xstorage',
					start_epoch: 1,
					end_epoch: 3,
					storage_size: '5',
				},
				deletable: true,
			},
		}));
		const sdk = {
			core: {
				getBalance: vi.fn(async () => ({ balance: '1000000' })),
				getObject: vi.fn(),
				getTransaction: vi.fn(),
				listCoins: vi.fn(),
				executeTransaction: vi.fn(),
				waitForTransaction: vi.fn(),
			},
			client: {},
		} as unknown as SuiSdkShim;
		const baseUrl = await listen(
			makeWalrusPublisherListener({
				client: { storageCost, writeBlob },
				signer,
				options: {
					bindAddress: '127.0.0.1',
					defaultEpochs: 3,
					defaultDeletable: false,
					maxBlobBytes: 64,
					suiTopUpMist: 2_000_000_000n,
					walTopUpMist: 1_000_000_000n,
				},
				sdk,
				suiFundingFaucetUrl: null,
				waitForFundsReady: Effect.void,
				exchange: null,
				walCoinType: '0x2::wal::WAL',
			}),
		);

		const response = await fetch(`${baseUrl}/v1/blobs?epochs=2&deletable=true&send_object_to=`, {
			method: 'PUT',
			body: 'hello',
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			newlyCreated: { blob_id: 'test-blob' },
			resourceOperation: { registerFromScratch: { encodedLength: '5', epochsAhead: 2 } },
			cost: 18,
		});
		expect(storageCost).toHaveBeenCalledWith(5, 2);
		expect(writeBlob).toHaveBeenCalledTimes(1);
		const call = writeBlob.mock.calls[0];
		expect(call).toBeDefined();
		if (call === undefined) throw new Error('writeBlob was not called');
		const [options] = call;
		expect(options.deletable).toBe(true);
		expect(options.epochs).toBe(2);
		expect(options.owner).toBe(signer.toSuiAddress());
		expect(Buffer.from(options.blob).toString('utf8')).toBe('hello');
	});
});
