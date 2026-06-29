// Walrus local HTTP services.
//
// These are intentionally host-process services, not extra Docker
// sidecars: the local storage-node committee remains the authoritative
// Walrus network, while these listeners provide the simple
// publisher/aggregator HTTP surface that applications expect.

import { dirname } from 'node:path';
import * as nodeFs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Effect, type Scope } from 'effect';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { BlobBlockedError, BlobNotCertifiedError, WalrusClient } from '@mysten/walrus';

import type { Identity } from '../../substrate/identity.ts';
import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { renderUrl, routedHostname } from '../../substrate/runtime/routed-url.ts';
import { listenScopedHttpServer } from '../../substrate/runtime/scoped-http-server.ts';
import { requestFundsWithRetry } from '../faucet/index.ts';
import { extractExecuteDigest, type SuiSdkShim } from '../sui/index.ts';
import { SUI_FULL_COIN_TYPE } from '../account/index.ts';
import { WALRUS_AGGREGATOR_ENDPOINT_NAME, WALRUS_PUBLISHER_ENDPOINT_NAME } from './routable.ts';
import { WALRUS_ROUTER_PORT } from './storage-nodes.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import { buildWalSwapTransaction, type WalExchangeHandle } from './wal-swap.ts';
import type {
	ResolvedWalrusLocalPublisherOptions,
	ResolvedWalrusLocalServiceOptions,
} from './mode/local-cluster.ts';

type WalrusHttpClient = Pick<WalrusClient, 'readBlob' | 'storageCost' | 'writeBlob'>;

export interface LocalWalrusHttpService {
	readonly port: number;
	readonly url: string;
}

export interface LocalWalrusHttpServices {
	readonly aggregator: LocalWalrusHttpService | null;
	readonly publisher: LocalWalrusHttpService | null;
}

export interface StartLocalWalrusHttpServicesArgs {
	readonly identity: Identity;
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly aggregator: ResolvedWalrusLocalServiceOptions | null;
	readonly publisher: ResolvedWalrusLocalPublisherOptions | null;
	readonly suiSdk: SuiSdkShim;
	readonly suiFundingFaucetUrl: string | null;
	readonly waitForFundsReady: Effect.Effect<void, unknown>;
	readonly exchange: WalExchangeHandle | null;
	readonly walCoinType: string;
	readonly publisherSignerPath: string;
}

const HTTP_JSON = 'application/json; charset=utf-8';
const HTTP_OCTET_STREAM = 'application/octet-stream';
const REQUEST_SOCKET_TIMEOUT_MS = 120_000;
const WAL_SWAP_GAS_RESERVE_MIST = 50_000_000n;
const BALANCE_WAIT_TIMEOUT_MS = 90_000;
const BALANCE_WAIT_INTERVAL_MS = 500;
const PUBLISHER_SIGNER_VERSION = 1;

interface PublisherSignerDoc {
	readonly version: typeof PUBLISHER_SIGNER_VERSION;
	readonly secretKey: string;
}

class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const isErrnoCode = (cause: unknown, code: string): boolean =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	(cause as { readonly code?: unknown }).code === code;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseBalanceAmount = (response: unknown): bigint | null => {
	const outer =
		typeof response === 'object' && response !== null && 'balance' in response
			? (response as { readonly balance?: unknown }).balance
			: response;
	const value =
		typeof outer === 'object' && outer !== null && 'balance' in outer
			? (outer as { readonly balance?: unknown }).balance
			: outer;
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
	if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
	return null;
};

const readBalance = async (
	sdk: SuiSdkShim,
	owner: string,
	coinType: string,
): Promise<bigint | null> => {
	try {
		return parseBalanceAmount(await sdk.core.getBalance({ owner, coinType }));
	} catch {
		return null;
	}
};

const waitForBalanceAtLeast = async (args: {
	readonly sdk: SuiSdkShim;
	readonly owner: string;
	readonly coinType: string;
	readonly amount: bigint;
	readonly label: string;
}): Promise<void> => {
	const deadline = Date.now() + BALANCE_WAIT_TIMEOUT_MS;
	let last: bigint | null = null;
	while (Date.now() <= deadline) {
		last = await readBalance(args.sdk, args.owner, args.coinType);
		if (last !== null && last >= args.amount) return;
		await sleep(BALANCE_WAIT_INTERVAL_MS);
	}
	throw new Error(
		`${args.label} balance for ${args.owner} did not reach ${args.amount} before timeout (last=${last === null ? '<unavailable>' : last})`,
	);
};

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const readPersistedPublisherSigner = (path: string): Effect.Effect<Ed25519Keypair | null, never> =>
	Effect.tryPromise({
		try: async () => {
			const raw = await nodeFs.readFile(path, 'utf8');
			const parsed = JSON.parse(raw) as Partial<PublisherSignerDoc>;
			if (parsed.version !== PUBLISHER_SIGNER_VERSION || typeof parsed.secretKey !== 'string') {
				throw new Error('publisher signer document did not match v1 shape');
			}
			const decoded = decodeSuiPrivateKey(parsed.secretKey);
			return Ed25519Keypair.fromSecretKey(decoded.secretKey);
		},
		catch: (cause) => cause,
	}).pipe(
		Effect.catch((cause: unknown) => {
			if (isErrnoCode(cause, 'ENOENT')) return Effect.succeed(null);
			return Effect.logWarning(
				`walrus publisher signer at ${path} could not be read; generating a new signer (${formatUnknownError(cause)})`,
			).pipe(Effect.as(null));
		}),
	);

const persistPublisherSigner = (
	path: string,
	keypair: Ed25519Keypair,
): Effect.Effect<'wrote' | 'exists', WalrusPluginError> =>
	Effect.tryPromise({
		try: async () => {
			await nodeFs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await nodeFs.chmod(dirname(path), 0o700).catch(() => {});
			const doc: PublisherSignerDoc = {
				version: PUBLISHER_SIGNER_VERSION,
				secretKey: keypair.getSecretKey(),
			};
			try {
				await nodeFs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, {
					flag: 'wx',
					mode: 0o600,
				});
				return 'wrote' as const;
			} catch (cause) {
				if (isErrnoCode(cause, 'EEXIST')) return 'exists' as const;
				throw cause;
			}
		},
		catch: (cause): WalrusPluginError =>
			walrusPluginError('publisher', `walrus publisher: failed to persist signer at ${path}.`, {
				cause,
			}),
	});

const acquirePublisherSigner = (path: string): Effect.Effect<Ed25519Keypair, WalrusPluginError> =>
	Effect.gen(function* () {
		const persisted = yield* readPersistedPublisherSigner(path);
		if (persisted !== null) return persisted;
		const generated = Ed25519Keypair.generate();
		const writeResult = yield* persistPublisherSigner(path, generated);
		if (writeResult === 'exists') {
			const winner = yield* readPersistedPublisherSigner(path);
			if (winner !== null) return winner;
		}
		return generated;
	});

const packageConfigForClient = (config: StartLocalWalrusHttpServicesArgs['packageConfig']) =>
	config.exchangeIds === undefined
		? {
				systemObjectId: config.systemObjectId,
				stakingPoolId: config.stakingPoolId,
			}
		: {
				systemObjectId: config.systemObjectId,
				stakingPoolId: config.stakingPoolId,
				exchangeIds: [...config.exchangeIds],
			};

const routedServiceUrl = (
	identity: Identity,
	role: string,
	phase: 'aggregator' | 'publisher',
): Effect.Effect<string, WalrusPluginError> =>
	routedHostname(identity, role).pipe(
		Effect.map((hostname) => renderUrl({ protocol: 'http', hostname, port: WALRUS_ROUTER_PORT })),
		Effect.mapError((cause) =>
			walrusPluginError(
				phase,
				`walrus ${phase}: failed to construct routed URL for ${role}: ${cause.detail}`,
				{ cause },
			),
		),
	);

const portProbeHostForBindAddress = (bindAddress: string): '0.0.0.0' | '127.0.0.1' =>
	bindAddress === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';

const startHttpService = (args: {
	readonly phase: 'aggregator' | 'publisher';
	readonly owner: string;
	readonly options: ResolvedWalrusLocalServiceOptions;
	readonly listener: (req: IncomingMessage, res: ServerResponse) => void;
}): Effect.Effect<LocalWalrusHttpService, WalrusPluginError, PortBrokerService | Scope.Scope> =>
	Effect.gen(function* () {
		const portBroker = yield* PortBrokerService;
		const allocated = yield* portBroker
			.allocate({
				owner: args.owner,
				probeHost: portProbeHostForBindAddress(args.options.bindAddress),
				...(args.options.port === undefined ? {} : { preferredPort: args.options.port }),
			})
			.pipe(
				Effect.mapError((cause) =>
					walrusPluginError(
						args.phase,
						`walrus ${args.phase}: port allocation failed: ${cause.detail}`,
						{ cause },
					),
				),
			);
		const server = yield* listenScopedHttpServer({
			bindAddress: args.options.bindAddress,
			port: allocated.port,
			listener: args.listener,
			onListenError: (cause): WalrusPluginError =>
				walrusPluginError(
					args.phase,
					`walrus ${args.phase}: HTTP server listen failed on ${args.options.bindAddress}:${allocated.port}: ${formatUnknownError(cause)}`,
					{ cause },
				),
		});
		return { port: allocated.port, url: server.url };
	});

const writeCorsHeaders = (res: ServerResponse): void => {
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-methods', 'GET, PUT, OPTIONS');
	res.setHeader('access-control-allow-headers', 'content-type');
};

const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
	if (res.writableEnded) return;
	writeCorsHeaders(res);
	res.statusCode = status;
	res.setHeader('content-type', HTTP_JSON);
	res.end(JSON.stringify(body));
};

const writeBytes = (res: ServerResponse, status: number, body: Uint8Array): void => {
	if (res.writableEnded) return;
	writeCorsHeaders(res);
	res.statusCode = status;
	res.setHeader('content-type', HTTP_OCTET_STREAM);
	res.end(Buffer.from(body));
};

const writeMethodNotAllowed = (res: ServerResponse): void =>
	writeJson(res, 405, { error: 'Method not allowed' });

const requestUrl = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://walrus.local');

export const makeWalrusAggregatorListener = (client: Pick<WalrusHttpClient, 'readBlob'>) => {
	const cache = new Map<string, Uint8Array>();
	return (req: IncomingMessage, res: ServerResponse): void => {
		req.socket.setTimeout(REQUEST_SOCKET_TIMEOUT_MS);
		if (req.method === 'OPTIONS') {
			writeCorsHeaders(res);
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== 'GET') {
			writeMethodNotAllowed(res);
			return;
		}
		const url = requestUrl(req);
		const prefix = '/v1/blobs/';
		if (!url.pathname.startsWith(prefix)) {
			writeJson(res, 404, { error: 'Not found' });
			return;
		}
		let blobId: string;
		try {
			blobId = decodeURIComponent(url.pathname.slice(prefix.length));
		} catch {
			writeJson(res, 400, { error: 'Invalid blob id encoding' });
			return;
		}
		if (blobId.length === 0) {
			writeJson(res, 400, { error: 'Missing blob id' });
			return;
		}
		const cached = cache.get(blobId);
		if (cached !== undefined) {
			writeBytes(res, 200, cached);
			return;
		}
		void client
			.readBlob({ blobId })
			.then((blob) => {
				const owned = blob.slice();
				cache.set(blobId, owned);
				writeBytes(res, 200, owned);
			})
			.catch((cause: unknown) => {
				if (cause instanceof BlobBlockedError || cause instanceof BlobNotCertifiedError) {
					writeJson(res, 404, { error: 'Blob not found' });
					return;
				}
				writeJson(res, 500, { error: 'Internal server error' });
			});
	};
};

const readRequestBody = (req: IncomingMessage, maxBytes: number): Promise<Uint8Array> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let overflowed = false;
		req.on('data', (chunk: Buffer) => {
			if (overflowed) return;
			totalBytes += chunk.length;
			if (totalBytes > maxBytes) {
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		req.on('error', (cause) => reject(cause));
		req.on('end', () => {
			if (overflowed) {
				reject(new HttpStatusError(413, `Blob body exceeds ${maxBytes} bytes`));
				return;
			}
			resolve(Buffer.concat(chunks));
		});
	});

const parsePositiveIntegerQuery = (url: URL, name: string, defaultValue: number): number => {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.length === 0) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
		throw new HttpStatusError(400, `${name} must be a positive integer`);
	}
	return parsed;
};

const parseDeletableQuery = (url: URL, defaultValue: boolean): boolean => {
	const raw = url.searchParams.get('deletable');
	if (raw === null || raw.length === 0) return defaultValue;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new HttpStatusError(400, 'deletable must be true or false');
};

const executeSignedPublisherTransaction = async (args: {
	readonly sdk: SuiSdkShim;
	readonly signer: Ed25519Keypair;
	readonly transaction: Transaction;
	readonly action: string;
}): Promise<string> => {
	const txBytes = await args.transaction.build({ client: args.sdk.client });
	const signed = await args.signer.signTransaction(txBytes);
	const raw = await args.sdk.core.executeTransaction({
		transaction: txBytes,
		signatures: [signed.signature],
		include: { effects: true, objectTypes: true },
	});
	const digest = extractExecuteDigest(raw);
	if (digest === undefined) {
		throw new Error(
			`${args.action} returned no transaction digest: ${JSON.stringify(raw).slice(0, 300)}`,
		);
	}
	await args.sdk.core.waitForTransaction({ digest });
	const env = raw as {
		readonly $kind?: 'Transaction' | 'FailedTransaction';
		readonly FailedTransaction?: {
			readonly status?: { readonly error?: string | { readonly message?: string } };
		};
	};
	if (env.$kind === 'FailedTransaction') {
		const error = env.FailedTransaction?.status?.error;
		const message =
			typeof error === 'string'
				? error
				: typeof error === 'object' && error !== null && typeof error.message === 'string'
					? error.message
					: 'no validator error attached';
		throw new Error(`${args.action} failed on-chain at ${digest}: ${message}`);
	}
	return digest;
};

const executePublisherWalSwap = async (args: {
	readonly sdk: SuiSdkShim;
	readonly signer: Ed25519Keypair;
	readonly exchange: WalExchangeHandle;
	readonly paymentMist: bigint;
}): Promise<void> => {
	const address = args.signer.toSuiAddress();
	const transaction = buildWalSwapTransaction({
		signerAddress: address,
		recipientAddress: address,
		exchange: args.exchange,
		paymentMist: args.paymentMist,
	});
	await executeSignedPublisherTransaction({
		sdk: args.sdk,
		signer: args.signer,
		transaction,
		action: 'WAL swap',
	});
};

const transferBlobObject = async (args: {
	readonly sdk: SuiSdkShim;
	readonly signer: Ed25519Keypair;
	readonly blobObjectId: string;
	readonly recipient: string | undefined;
}): Promise<void> => {
	const signerAddress = args.signer.toSuiAddress();
	if (args.recipient === undefined || args.recipient === signerAddress) return;
	const transaction = new Transaction();
	transaction.setSender(signerAddress);
	transaction.transferObjects([transaction.object(args.blobObjectId)], args.recipient);
	await executeSignedPublisherTransaction({
		sdk: args.sdk,
		signer: args.signer,
		transaction,
		action: `blob object transfer to ${args.recipient}`,
	});
};

const ensurePublisherWal = async (args: {
	readonly sdk: SuiSdkShim;
	readonly signer: Ed25519Keypair;
	readonly walCoinType: string;
	readonly exchange: WalExchangeHandle | null;
	readonly suiFundingFaucetUrl: string | null;
	readonly waitForFundsReady: Effect.Effect<void, unknown>;
	readonly requiredWalMist: bigint;
	readonly walTopUpMist: bigint;
	readonly suiTopUpMist: bigint;
}): Promise<void> => {
	const address = args.signer.toSuiAddress();
	const existingWal = await readBalance(args.sdk, address, args.walCoinType);
	if (existingWal !== null && existingWal >= args.requiredWalMist) return;
	if (args.exchange === null) {
		throw new HttpStatusError(
			503,
			'Local Walrus publisher requires a WAL exchange object, but this deployment did not expose one.',
		);
	}
	if (args.suiFundingFaucetUrl === null) {
		throw new HttpStatusError(
			503,
			'Local Walrus publisher requires a SUI funding faucet for its signer.',
		);
	}
	const missingWal =
		existingWal === null || existingWal >= args.requiredWalMist
			? args.requiredWalMist
			: args.requiredWalMist - existingWal;
	const paymentMist = maxBigInt(args.walTopUpMist, missingWal);
	const requiredSui = paymentMist + WAL_SWAP_GAS_RESERVE_MIST;
	const existingSui = await readBalance(args.sdk, address, SUI_FULL_COIN_TYPE);
	if (existingSui === null || existingSui < requiredSui) {
		await Effect.runPromise(args.waitForFundsReady);
		await Effect.runPromise(
			requestFundsWithRetry({
				faucetUrl: args.suiFundingFaucetUrl,
				address,
				amount: maxBigInt(args.suiTopUpMist, requiredSui),
			}),
		);
		await waitForBalanceAtLeast({
			sdk: args.sdk,
			owner: address,
			coinType: SUI_FULL_COIN_TYPE,
			amount: requiredSui,
			label: 'SUI',
		});
	}
	await executePublisherWalSwap({
		sdk: args.sdk,
		signer: args.signer,
		exchange: args.exchange,
		paymentMist,
	});
	await waitForBalanceAtLeast({
		sdk: args.sdk,
		owner: address,
		coinType: args.walCoinType,
		amount: args.requiredWalMist,
		label: 'WAL',
	});
};

const serializePublisherRequests = () => {
	let tail: Promise<void> = Promise.resolve();
	return async <A>(body: () => Promise<A>): Promise<A> => {
		const run = tail.then(body, body);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
};

export const makeWalrusPublisherListener = (args: {
	readonly client: Pick<WalrusHttpClient, 'storageCost' | 'writeBlob'>;
	readonly signer: Ed25519Keypair;
	readonly options: ResolvedWalrusLocalPublisherOptions;
	readonly sdk: SuiSdkShim;
	readonly suiFundingFaucetUrl: string | null;
	readonly waitForFundsReady: Effect.Effect<void, unknown>;
	readonly exchange: WalExchangeHandle | null;
	readonly walCoinType: string;
}) => {
	const serialize = serializePublisherRequests();
	return (req: IncomingMessage, res: ServerResponse): void => {
		req.socket.setTimeout(REQUEST_SOCKET_TIMEOUT_MS);
		if (req.method === 'OPTIONS') {
			writeCorsHeaders(res);
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== 'PUT') {
			writeMethodNotAllowed(res);
			return;
		}
		const url = requestUrl(req);
		if (url.pathname !== '/v1/blobs') {
			writeJson(res, 404, { error: 'Not found' });
			return;
		}
		void readRequestBody(req, args.options.maxBlobBytes)
			.then((blob) =>
				serialize(async () => {
					const epochs = parsePositiveIntegerQuery(url, 'epochs', args.options.defaultEpochs);
					const deletable = parseDeletableQuery(url, args.options.defaultDeletable);
					const sendObjectToRaw = url.searchParams.get('send_object_to');
					const sendObjectTo =
						sendObjectToRaw === null || sendObjectToRaw.length === 0 ? undefined : sendObjectToRaw;
					const { storageCost, writeCost, totalCost } = await args.client.storageCost(
						blob.length,
						epochs,
					);
					await ensurePublisherWal({
						sdk: args.sdk,
						signer: args.signer,
						walCoinType: args.walCoinType,
						exchange: args.exchange,
						suiFundingFaucetUrl: args.suiFundingFaucetUrl,
						waitForFundsReady: args.waitForFundsReady,
						requiredWalMist: totalCost,
						walTopUpMist: args.options.walTopUpMist,
						suiTopUpMist: args.options.suiTopUpMist,
					});
					const { blobObject } = await args.client.writeBlob({
						blob,
						deletable,
						epochs,
						signer: args.signer,
						owner: args.signer.toSuiAddress(),
					});
					await transferBlobObject({
						sdk: args.sdk,
						signer: args.signer,
						blobObjectId: blobObject.id,
						recipient: sendObjectTo,
					});
					writeJson(res, 200, {
						newlyCreated: {
							...blobObject,
							id: blobObject.id,
							storage: {
								...blobObject.storage,
								id: blobObject.storage.id,
							},
						},
						resourceOperation: {
							registerFromScratch: {
								encodedLength: blobObject.storage.storage_size,
								epochsAhead: epochs,
							},
						},
						cost: Number(storageCost + writeCost),
					});
				}),
			)
			.catch((cause: unknown) => {
				if (cause instanceof HttpStatusError) {
					writeJson(res, cause.status, { error: cause.message });
					return;
				}
				writeJson(res, 500, { error: 'Internal server error' });
			});
	};
};

export const startLocalWalrusHttpServices = (
	args: StartLocalWalrusHttpServicesArgs,
): Effect.Effect<LocalWalrusHttpServices, WalrusPluginError, PortBrokerService | Scope.Scope> =>
	Effect.gen(function* () {
		const client = new WalrusClient({
			packageConfig: packageConfigForClient(args.packageConfig),
			suiClient: args.suiSdk.client,
			storageNodeUrlScheme: 'http',
		});
		const aggregatorUrl =
			args.aggregator === null
				? null
				: yield* routedServiceUrl(args.identity, WALRUS_AGGREGATOR_ENDPOINT_NAME, 'aggregator');
		const publisherUrl =
			args.publisher === null
				? null
				: yield* routedServiceUrl(args.identity, WALRUS_PUBLISHER_ENDPOINT_NAME, 'publisher');

		const aggregator =
			args.aggregator === null
				? null
				: yield* startHttpService({
						phase: 'aggregator',
						owner: 'walrus:aggregator',
						options: args.aggregator,
						listener: makeWalrusAggregatorListener(client),
					}).pipe(Effect.map((service) => ({ ...service, url: aggregatorUrl! })));

		const publisherSigner =
			args.publisher === null ? null : yield* acquirePublisherSigner(args.publisherSignerPath);
		const publisher =
			args.publisher === null || publisherSigner === null
				? null
				: yield* startHttpService({
						phase: 'publisher',
						owner: 'walrus:publisher',
						options: args.publisher,
						listener: makeWalrusPublisherListener({
							client,
							signer: publisherSigner,
							options: args.publisher,
							sdk: args.suiSdk,
							suiFundingFaucetUrl: args.suiFundingFaucetUrl,
							waitForFundsReady: args.waitForFundsReady,
							exchange: args.exchange,
							walCoinType: args.walCoinType,
						}),
					}).pipe(Effect.map((service) => ({ ...service, url: publisherUrl! })));

		return { aggregator, publisher };
	});
