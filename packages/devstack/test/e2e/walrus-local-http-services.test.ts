// Real local Walrus publisher/aggregator/upload-relay smoke.
//
// Unlike private-content-boot.test.ts this deliberately does NOT set
// WALRUS_CARGO_IMAGE_OVERRIDE. The goal is to prove the release-provided
// `walrus publisher`, `walrus aggregator`, and `walrus-upload-relay` containers
// can publish/read through their routed HTTP endpoints and reach the local
// storage-node committee.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusClient } from '@mysten/walrus';
import { Effect } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';

import { readStackEngine } from '../../src/api/define-devstack.ts';
import { account, defineDevstack, sui, walCoin, walrus } from '../../src/index.ts';
import { WALRUS_ENTRYPOINTS } from '../../src/plugins/walrus/routable.ts';
import {
	dockerReachable,
	pruneManagedImagesForApp,
	removeManagedContainersForAppStack,
} from './docker-prune.ts';
import { runBoot, type BootScopeContext } from './boot-config-impl.ts';
import { fundAddress, suiClientOf } from './snapshot-matrix/clients.ts';

const APP = 'walrus-http-smoke';
const STACK = 'walrus-http-smoke';
const KEEP_CONTAINERS = process.env.WALRUS_HTTP_SMOKE_KEEP_CONTAINERS === '1';

interface WalrusHttpResolved {
	readonly mode: 'local' | 'known';
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly uploadRelayUrl: string | null;
	readonly walCoinType: string | null;
}

const ensureRealWalrusImage = (): void => {
	delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
};

const walrusValue = (ctx: BootScopeContext): WalrusHttpResolved => {
	const value = ctx.resolvedValues.get('walrus:walrus') as WalrusHttpResolved | undefined;
	if (value === undefined) {
		throw new Error(
			`walrus-http-smoke: walrus resolved value missing; keys=[${[
				...ctx.resolvedValues.keys(),
			].join(', ')}]`,
		);
	}
	return value;
};

const extractBlobId = (response: unknown): string => {
	const paths: ReadonlyArray<ReadonlyArray<string>> = [
		['newlyCreated', 'blobObject', 'blobId'],
		['newlyCreated', 'blobObject', 'blob_id'],
		['newlyCreated', 'blobId'],
		['newlyCreated', 'blob_id'],
		['blobId'],
		['blob_id'],
	];
	for (const path of paths) {
		let cursor = response;
		for (const segment of path) {
			cursor =
				typeof cursor === 'object' && cursor !== null
					? (cursor as Record<string, unknown>)[segment]
					: undefined;
		}
		if (typeof cursor === 'string' && cursor.length > 0) return cursor;
	}
	throw new Error(
		`walrus-http-smoke: publisher response did not contain a blob id: ${JSON.stringify(
			response,
		).slice(0, 1_000)}`,
	);
};

const singleContainer = async (
	ctx: BootScopeContext,
	role: 'aggregator' | 'publisher' | 'upload-relay',
) => {
	const handles = await Effect.runPromise(
		ctx.containerRuntime.inspectByLabels({
			app: APP,
			stack: STACK,
			plugin: 'walrus',
			role,
		}),
	);
	if (handles.length !== 1) {
		throw new Error(
			`walrus-http-smoke: expected one ${role} container, found ${handles.length}: ${handles
				.map((h) => h.name)
				.join(', ')}`,
		);
	}
	return handles[0]!;
};

const requireEndpoint = (label: string, url: string | null): string => {
	expect(url).toMatch(/^http:\/\//);
	if (url === null) {
		throw new Error(`walrus-http-smoke: missing ${label} URL`);
	}
	return url;
};

const waitForRoutedStatus = async (
	label: string,
	baseUrl: string,
	path = '/status',
): Promise<void> => {
	const url = new URL(path, baseUrl);
	const deadline = Date.now() + 30_000;
	let last = 'no attempts';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
			last = `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`;
		} catch (cause) {
			last = String(cause);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`walrus-http-smoke: routed ${label} /status never became ready: ${last}`);
};

const readBlobThroughAggregator = async (baseUrl: string, blobId: string): Promise<string> => {
	const url = new URL(`/v1/blobs/${blobId}`, baseUrl);
	const deadline = Date.now() + 60_000;
	let last = 'no attempts';
	while (Date.now() < deadline) {
		const response = await fetch(url);
		const body = await response.text();
		if (response.ok) return body;
		last = `HTTP ${response.status}: ${body.slice(0, 1_000)}`;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`walrus-http-smoke: routed aggregator GET never succeeded: ${last}`);
};

const writeBlobThroughUploadRelay = async (
	ctx: BootScopeContext,
	walrusResolved: WalrusHttpResolved,
	uploadRelayUrl: string,
	payload: string,
): Promise<{ readonly blobId: string; readonly blobObjectId: string }> => {
	const suiClient = suiClientOf(ctx);
	const signer = Ed25519Keypair.generate();
	await Effect.runPromise(
		fundAddress(ctx, suiClient, signer.toSuiAddress(), {
			suiAmount: 5_000_000_000n,
			walAmount: 2_000_000_000n,
		}),
	);

	const client = new WalrusClient({
		suiClient,
		packageConfig: {
			systemObjectId: walrusResolved.packageConfig.systemObjectId,
			stakingPoolId: walrusResolved.packageConfig.stakingPoolId,
			...(walrusResolved.packageConfig.exchangeIds
				? { exchangeIds: [...walrusResolved.packageConfig.exchangeIds] }
				: {}),
		},
		storageNodeUrlScheme: 'https',
		uploadRelay: {
			host: uploadRelayUrl,
		},
	});

	const written = await client.writeBlob({
		blob: new TextEncoder().encode(payload),
		deletable: true,
		epochs: 3,
		signer,
	});

	return { blobId: written.blobId, blobObjectId: written.blobObject.id };
};

describe('walrus local HTTP publisher/aggregator/upload-relay @e2e', () => {
	afterAll(() => {
		if (KEEP_CONTAINERS) return;
		removeManagedContainersForAppStack(APP, STACK);
		pruneManagedImagesForApp(APP);
	});

	it('publishes through the Rust publisher and reads through the Rust aggregator', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`walrus-http-smoke: skipping — ${docker.detail}`);
			return;
		}
		ensureRealWalrusImage();
		if (!KEEP_CONTAINERS) removeManagedContainersForAppStack(APP, STACK);

		const localnet = sui();
		const walrusCluster = walrus({ local: { nodeCount: 4 } });
		const wal = walCoin(walrusCluster);
		const bank = account('bank', {
			kind: 'ephemeral',
			funding: [
				{ coin: 'sui', amount: 1_000_000_000_000n },
				{ coin: wal, amount: 10_000_000_000n },
			],
		});
		const engine = readStackEngine(
			defineDevstack({
				members: [localnet, walrusCluster, wal, bank],
				stackName: STACK,
			}),
		);

		let exercisedHttpServices = false;
		const boot = await runBoot({
			stack: engine,
			appName: APP,
			stackName: STACK,
			useRealRouter: true,
			routerEntrypoints: WALRUS_ENTRYPOINTS,
			withinScope: (ctx) =>
				Effect.tryPromise({
					try: async () => {
						if (!ctx.resolvedValues.has('walrus:walrus')) return;
						const walrusResolved = walrusValue(ctx);
						expect(walrusResolved.mode).toBe('local');
						const publisherBaseUrl = requireEndpoint('publisher', walrusResolved.publisherUrl);
						const aggregatorBaseUrl = requireEndpoint('aggregator', walrusResolved.aggregatorUrl);
						const uploadRelayBaseUrl = requireEndpoint(
							'upload relay',
							walrusResolved.uploadRelayUrl,
						);

						const payload = `walrus-http-smoke ${Date.now()} ${'x'.repeat(64)}`;
						const publisher = await singleContainer(ctx, 'publisher');
						await singleContainer(ctx, 'aggregator');
						await singleContainer(ctx, 'upload-relay');

						const internalHealth = await Effect.runPromise(
							ctx.containerRuntime.exec(publisher, [
								'sh',
								'-c',
								'getent hosts dryrun-node-0 >/dev/null && curl -fks https://dryrun-node-0:9185/v1/health >/dev/null',
							]),
						);
						if (internalHealth.exitCode !== 0) {
							throw new Error(
								`walrus-http-smoke: publisher could not reach dryrun-node-0 exit=${internalHealth.exitCode}: ${internalHealth.stderr}`,
							);
						}

						await waitForRoutedStatus('publisher', publisherBaseUrl);
						await waitForRoutedStatus('aggregator', aggregatorBaseUrl);
						await waitForRoutedStatus('upload relay', uploadRelayBaseUrl, '/v1/tip-config');

						const publisherUrl = new URL('/v1/blobs', publisherBaseUrl);
						publisherUrl.searchParams.set('epochs', '3');
						publisherUrl.searchParams.set('deletable', 'true');
						const payloadBytes = new TextEncoder().encode(payload);
						const publish = await fetch(publisherUrl, {
							method: 'PUT',
							body: payloadBytes.buffer as ArrayBuffer,
						});
						const publishBody = await publish.text();
						if (!publish.ok) {
							throw new Error(
								`walrus-http-smoke: routed publisher PUT failed HTTP ${publish.status}: ${publishBody.slice(0, 1_000)}`,
							);
						}
						const blobId = extractBlobId(JSON.parse(publishBody) as unknown);

						expect(await readBlobThroughAggregator(aggregatorBaseUrl, blobId)).toBe(payload);

						const relayPayload = `walrus-http-smoke upload-relay ${Date.now()} ${'y'.repeat(64)}`;
						const relayWrite = await writeBlobThroughUploadRelay(
							ctx,
							walrusResolved,
							uploadRelayBaseUrl,
							relayPayload,
						);
						expect(relayWrite.blobObjectId).toMatch(/^0x[0-9a-f]+$/i);
						expect(await readBlobThroughAggregator(aggregatorBaseUrl, relayWrite.blobId)).toBe(
							relayPayload,
						);
						exercisedHttpServices = true;
					},
					catch: (cause) => cause,
				}).pipe(Effect.orDie),
		});

		expect(boot.failures).toEqual([]);
		expect(boot.topLevelErrorCount).toBe(0);
		expect(exercisedHttpServices).toBe(true);
	});
});
