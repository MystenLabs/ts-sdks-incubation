// Sui plugin — fork mode.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Duration, Effect, type Scope } from 'effect';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeSuiAddress, normalizeSuiObjectId } from '@mysten/sui/utils';

import type {
	ContainerHandle,
	ContainerPortPublish,
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
	PortBindingReconciliation,
} from '../../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import type { Identity } from '../../../substrate/identity.ts';
import { ensureManagedContainer } from '../../../substrate/runtime/managed-container.ts';
import { SpanAttr } from '../../../substrate/runtime/observability/spans.ts';
import type { StackPaths } from '../../../substrate/runtime/paths.ts';
import type { AllocatedPort, PortBroker } from '../../../substrate/runtime/port-broker/index.ts';
import { ProbeTimeoutError, waitForProbe } from '../../../substrate/runtime/probes.ts';
import { stringifyCause } from '../stringify-cause.ts';
import { renderUrl, routerHostname } from '../../../orchestrators/router/hostname.ts';
import { resolveAutoTickIntervalMs, runAutoTickClock } from '../auto-tick.ts';
import { suiPluginError, type SeedManifestMismatchError, type SuiPluginError } from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import { SUI_RPC_ENDPOINT_NAME, SUI_RPC_ENTRYPOINT_PORT } from '../routable.ts';
import { SuiSpans } from '../spans.ts';
import { wrapWithForkGuard } from '../fork-orchestration.ts';
import { verifyForkImpersonationSender } from '../fork-transaction.ts';
import { DEFAULT_SUI_CLI_VERSION } from '../../../substrate/runtime/sui-move-build/index.ts';
import type { ForkAdminSurface, SuiClient } from './shared.ts';
import { toDockerHostGatewayUrl } from './shared.ts';
import {
	assembleSuiClient,
	fetchChainId as sharedFetchChainId,
	makeResolvedNetwork,
	noopWaitForTransactionsReady,
} from './shared-boot.ts';
import type { SuiForkOptions } from './spec.ts';

/** Default ready-probe timeout for fork-mode cold start. */
export const DEFAULT_FORK_READY_TIMEOUT = Duration.seconds(180);

/** Default Sui repository revision used by the bundled `sui-fork` image build. */
export const DEFAULT_SUI_FORK_REV = '62ee6ada958cd61b3c8a4466dd33c9aba3cdff8a';

/** Map upstream literal to the canonical "live" chain id known by wallet-standard / MVR. */
export const FORK_UPSTREAM_TO_KNOWN_NETWORK = {
	mainnet: 'sui:mainnet',
	testnet: 'sui:testnet',
	devnet: 'sui:devnet',
} as const;

export const DEFAULT_FORK_HOST_RPC_PORT = 51002;
export const FORK_VALIDATOR_STOP_GRACE_SECONDS = 30;

const DOCKER_PUBLISH_HOST = '0.0.0.0' as const;
const CONTAINER_RPC_PORT = SUI_RPC_ENTRYPOINT_PORT;
const FORK_CONTAINER_DATA_DIR = '/var/lib/sui-fork';
const PROBE_ATTEMPT_TIMEOUT_MS = 3_000;

/** Resolved fork-mode boot artifacts. */
export interface ForkModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
	readonly autoTickIntervalMs: number | undefined;
}

export const bootForkMode = (
	runtime: ContainerRuntime,
	identity: Identity,
	portBroker: PortBroker,
	paths: StackPaths,
	opts: SuiForkOptions,
): Effect.Effect<ForkModeBootResult, SuiPluginError | SeedManifestMismatchError, Scope.Scope> =>
	Effect.gen(function* () {
		const autoTickIntervalMs = resolveAutoTickIntervalMs(opts.autoTick);
		const image = yield* resolveForkImage(runtime, identity, opts);
		const dataDir = yield* ensureForkDataDir(paths, opts);

		const labels: ContainerLabelTuple = {
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'fork-validator',
		};
		const containerName = `devstack-${identity.app}-${identity.stack}-sui-fork`;
		const { handle, ports } = yield* ensureForkContainer({
			runtime,
			portBroker,
			image,
			labels,
			containerName,
			dataDir,
			opts,
		});

		const published = pickPublishedPort(ports, handle.ports);
		const directRpcUrl = `http://127.0.0.1:${published.hostPort}`;
		const rpcUrl = yield* routedSuiRpcUrl(identity);
		const sdkClient = new SuiGrpcClient({ baseUrl: directRpcUrl, network: opts.upstream });
		const readyTimeout = opts.readyTimeout ?? DEFAULT_FORK_READY_TIMEOUT;

		const status = yield* waitForForkReady(sdkClient, readyTimeout).pipe(
			Effect.annotateLogs({ [SuiSpans.container]: handle.name }),
		);
		const chain = yield* sharedFetchChainId(sdkClient, {
			span: 'devstack.plugin.sui.fork.fetchChainId',
		});

		const fork = makeForkAdminSurface(sdkClient);
		const assembled = assembleSuiClient({
			sdkClient,
			chain,
			rpcUrl,
			waitForTransactionsReady: noopWaitForTransactionsReady,
			buildImage: image,
			hostGateway: {
				rpcUrl: toDockerHostGatewayUrl(directRpcUrl),
				faucetUrl: null,
				graphqlUrl: null,
			},
		});
		const client: SuiClient = {
			...assembled.client,
			sdk: wrapWithForkGuard(assembled.sdkShim),
			fork,
		};

		if (autoTickIntervalMs !== undefined) {
			yield* runAutoTickClock(fork, autoTickIntervalMs);
		}

		return {
			resolved: makeResolvedNetwork({
				mode: 'fork',
				chain,
				rpc: rpcUrl,
				source: 'default',
				checkpoint: status.forkedAtCheckpoint,
				forkUpstream: opts.upstream,
			}),
			client,
			autoTickIntervalMs,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.fork.boot', { attributes: { [SpanAttr.plugin]: 'sui' } }),
	);

export const suiForkImageBuildContext = (rev = DEFAULT_SUI_FORK_REV) => ({
	contextPath: new URL('../../../../images/', import.meta.url).pathname,
	dockerfile: 'sui-fork/Dockerfile',
	buildArgs: { SUI_FORK_REV: rev, SUI_CLI_VERSION: DEFAULT_SUI_CLI_VERSION },
});

export const resolveForkImage = (
	runtime: ContainerRuntime,
	identity: Identity,
	opts: SuiForkOptions,
): Effect.Effect<ImageRef, SuiPluginError> =>
	Effect.gen(function* () {
		if (opts.image && 'pull' in opts.image) {
			const pullRef = opts.image.pull;
			if (runtime.pullImage === undefined) {
				return yield* Effect.fail(
					suiPluginError(
						'image-build',
						`sui fork mode cannot pull image '${pullRef}' because the configured container runtime does not expose image pulls.`,
					),
				);
			}
			return yield* runtime
				.pullImage(pullRef)
				.pipe(
					Effect.mapError((cause) =>
						suiPluginError(
							'image-build',
							`sui fork mode failed to pull image '${pullRef}': ${cause.reason}: ${cause.detail}`,
							cause,
						),
					),
				);
		}
		const rev = opts.version ?? DEFAULT_SUI_FORK_REV;
		const owner = {
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'validator',
		} as const;
		const buildCtx =
			opts.image && 'build' in opts.image
				? {
						contextPath: opts.image.build.context,
						dockerfile: opts.image.build.dockerfile ?? 'Dockerfile',
						buildArgs: { SUI_FORK_REV: rev, SUI_CLI_VERSION: DEFAULT_SUI_CLI_VERSION },
						owner,
					}
				: { ...suiForkImageBuildContext(rev), owner };
		return yield* runtime
			.ensureImage(buildCtx)
			.pipe(
				Effect.mapError((cause) =>
					suiPluginError(
						'image-build',
						`sui fork image build failed: ${cause.reason}: ${cause.detail}`,
						cause,
					),
				),
			);
	}).pipe(Effect.withSpan('devstack.plugin.sui.fork.resolveImage'));

interface ForkContainerResult {
	readonly handle: ContainerHandle;
	readonly ports: ReadonlyArray<ContainerPortPublish>;
}

const ensureForkContainer = (params: {
	readonly runtime: ContainerRuntime;
	readonly portBroker: PortBroker;
	readonly image: ImageRef;
	readonly labels: ContainerLabelTuple;
	readonly containerName: string;
	readonly dataDir: string;
	readonly opts: SuiForkOptions;
}): Effect.Effect<ForkContainerResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const reusable =
			params.opts.ports === undefined
				? yield* findReusableForkPort(params.runtime, params.labels, params.containerName)
				: undefined;
		const ports =
			reusable === undefined
				? [yield* allocateForkRpcPort(params.portBroker, params.opts.ports)]
				: [reusable];
		const reconciliation: PortBindingReconciliation =
			reusable === undefined && params.opts.ports !== undefined ? 'exact' : 'adopt-existing';
		const command = forkStartCommand(params.opts);
		const handle = yield* ensureManagedContainer({
			runtime: params.runtime,
			labels: params.labels,
			spec: {
				name: params.containerName,
				image: params.image,
				recreate: 'on-config-change',
				configHash: forkContainerConfigHash(params.opts, params.dataDir, command),
				stopGraceSeconds: FORK_VALIDATOR_STOP_GRACE_SECONDS,
				ports,
				portBindingReconciliation: reconciliation,
				mounts: [{ source: params.dataDir, target: FORK_CONTAINER_DATA_DIR }],
				command,
			},
			mapError: (cause) => cause,
		}).pipe(
			Effect.mapError((cause: ContainerRuntimeError) =>
				suiPluginError(
					'container-start',
					`sui-fork container failed: ${cause.reason}: ${cause.detail}`,
					cause,
				),
			),
		);
		return { handle, ports };
	});

export const forkStartCommand = (opts: SuiForkOptions): ReadonlyArray<string> => {
	const seed = normalizeForkSeed(opts);
	const command = [
		'start',
		'--network',
		opts.upstream,
		'--data-dir',
		FORK_CONTAINER_DATA_DIR,
		'--rpc-addr',
		`0.0.0.0:${CONTAINER_RPC_PORT}`,
	];
	if (opts.checkpoint !== undefined) {
		command.push('--checkpoint', String(opts.checkpoint));
	}
	for (const address of seed.addresses) {
		command.push('--address', address);
	}
	for (const objectId of seed.objects) {
		command.push('--object', objectId);
	}
	return command;
};

const normalizeForkSeed = (opts: SuiForkOptions) => ({
	addresses: [
		...new Set((opts.seed?.addresses ?? []).map((address) => normalizeSuiAddress(address))),
	].sort(),
	objects: [
		...new Set((opts.seed?.objects ?? []).map((objectId) => normalizeSuiObjectId(objectId))),
	].sort(),
});

const forkContainerConfigHash = (
	opts: SuiForkOptions,
	dataDir: string,
	command: ReadonlyArray<string>,
): string =>
	createHash('sha256')
		.update(
			JSON.stringify({
				dataDir,
				command,
				version: opts.version ?? DEFAULT_SUI_FORK_REV,
				ports: opts.ports ?? null,
			}),
		)
		.digest('hex');

const allocateForkRpcPort = (
	portBroker: PortBroker,
	override: Readonly<Record<number, number>> | undefined,
): Effect.Effect<ContainerPortPublish, SuiPluginError, Scope.Scope> => {
	const overridePort = override?.[CONTAINER_RPC_PORT];
	if (overridePort !== undefined) {
		return Effect.succeed(portPublish(CONTAINER_RPC_PORT, overridePort));
	}
	return portBroker
		.allocate({
			owner: 'sui:fork-rpc',
			preferredPort: DEFAULT_FORK_HOST_RPC_PORT,
			probeHost: DOCKER_PUBLISH_HOST,
		})
		.pipe(
			Effect.catchTag('PortBrokerError', (cause) =>
				cause.reason === 'preferred-busy'
					? portBroker.allocate({ owner: 'sui:fork-rpc', probeHost: DOCKER_PUBLISH_HOST })
					: Effect.fail(cause),
			),
			Effect.map((allocated: AllocatedPort) => portPublish(CONTAINER_RPC_PORT, allocated.port)),
			Effect.mapError((cause) =>
				suiPluginError(
					'port-allocate',
					`sui fork mode: failed to allocate RPC host port: ${cause.detail}`,
					cause,
				),
			),
		);
};

const findReusableForkPort = (
	runtime: ContainerRuntime,
	labels: ContainerLabelTuple,
	containerName: string,
): Effect.Effect<ContainerPortPublish | undefined, SuiPluginError> =>
	runtime.inspectByLabels(labels).pipe(
		Effect.map((handles) =>
			handles
				.find((handle) => handle.name === containerName)
				?.ports?.find((port) => port.containerPort === CONTAINER_RPC_PORT),
		),
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui fork mode: failed to inspect existing fork container: ${cause.reason}: ${cause.detail}`,
				cause,
			),
		),
	);

const pickPublishedPort = (
	requested: ReadonlyArray<ContainerPortPublish>,
	actual: ReadonlyArray<ContainerPortPublish> | undefined,
): ContainerPortPublish =>
	actual?.find((port) => port.containerPort === CONTAINER_RPC_PORT) ??
	requested.find((port) => port.containerPort === CONTAINER_RPC_PORT) ??
	portPublish(CONTAINER_RPC_PORT, DEFAULT_FORK_HOST_RPC_PORT);

const portPublish = (containerPort: number, hostPort: number): ContainerPortPublish => ({
	containerPort,
	hostPort,
	hostIp: DOCKER_PUBLISH_HOST,
});

export const forkDataDirKey = (opts: SuiForkOptions): string =>
	createHash('sha256')
		.update(
			JSON.stringify({
				upstream: opts.upstream,
				checkpoint: opts.checkpoint ?? null,
				version: opts.version ?? DEFAULT_SUI_FORK_REV,
				seed: normalizeForkSeed(opts),
			}),
		)
		.digest('hex')
		.slice(0, 16);

const ensureForkDataDir = (
	paths: StackPaths,
	opts: SuiForkOptions,
): Effect.Effect<string, SuiPluginError> => {
	const dataDir = resolve(join(paths.stackRoot, 'sui-fork', forkDataDirKey(opts)));
	return Effect.tryPromise({
		try: async () => {
			await mkdir(dataDir, { recursive: true, mode: 0o700 });
			return dataDir;
		},
		catch: (cause) =>
			suiPluginError(
				'fork-data-dir',
				`sui fork mode: failed to create data directory ${dataDir}: ${stringifyCause(cause)}`,
				cause,
			),
	});
};

interface ForkStatus {
	readonly checkpoint: string;
	readonly clock: number;
	readonly forkedAtCheckpoint: string;
}

const waitForForkReady = (
	sdkClient: SuiGrpcClient,
	readyTimeout: Duration.Duration,
): Effect.Effect<ForkStatus, SuiPluginError> =>
	Effect.gen(function* () {
		const readyTimeoutMs = Duration.toMillis(readyTimeout);
		yield* waitForProbe({
			label: 'sui.fork.rpc',
			timeoutMs: readyTimeoutMs,
			intervalMs: 1_000,
			attemptTimeoutMs: PROBE_ATTEMPT_TIMEOUT_MS,
			probe: () => readForkStatus(sdkClient).pipe(Effect.as(true)),
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ProbeTimeoutError
					? suiPluginError(
							'fork-status-probe',
							`sui fork mode: ForkingService.GetStatus did not become ready within ${readyTimeoutMs}ms.`,
							cause.lastError ?? cause.lastNotReady ?? cause,
						)
					: suiPluginError(
							'fork-status-probe',
							`sui fork mode: ForkingService.GetStatus probe failed: ${stringifyCause(cause)}`,
							cause,
						),
			),
		);
		return yield* readForkStatus(sdkClient);
	}).pipe(Effect.withSpan('devstack.plugin.sui.fork.waitForReady'));

const makeForkAdminSurface = (sdkClient: SuiGrpcClient): ForkAdminSurface => ({
	status: readForkStatus(sdkClient).pipe(
		Effect.map(({ checkpoint, clock }) => ({ checkpoint, clock })),
	),
	advanceClock: (intervalMs) =>
		Effect.tryPromise({
			try: () => sdkClient.forkingService.advanceClock({ durationMs: BigInt(intervalMs) }).response,
			catch: (cause) =>
				suiPluginError(
					'fork-advance-clock',
					`sui fork mode: advanceClock(${intervalMs}) failed: ${stringifyCause(cause)}`,
					cause,
				),
		}).pipe(Effect.asVoid),
	advanceCheckpoint: Effect.tryPromise({
		try: () => sdkClient.forkingService.advanceCheckpoint({}).response,
		catch: (cause) =>
			suiPluginError(
				'fork-advance-checkpoint',
				`sui fork mode: advanceCheckpoint failed: ${stringifyCause(cause)}`,
				cause,
			),
	}).pipe(Effect.asVoid),
	impersonate: (sender, tx) =>
		Effect.gen(function* () {
			if (!(tx instanceof Uint8Array)) {
				return yield* Effect.fail(
					suiPluginError(
						'fork-impersonate',
						`sui fork mode: impersonate(${sender}) expected serialized transaction bytes.`,
					),
				);
			}
			yield* verifyForkImpersonationSender(sender, tx);
			const raw = yield* Effect.tryPromise({
				try: () =>
					sdkClient.core.executeTransaction({
						transaction: tx,
						signatures: [],
						include: { effects: true, objectTypes: true },
					}),
				catch: (cause) =>
					suiPluginError(
						'fork-impersonate',
						`sui fork mode: impersonate(${sender}) failed: ${stringifyCause(cause)}`,
						cause,
					),
			});
			const digest = extractExecuteDigest(raw);
			if (digest === undefined) {
				return yield* Effect.fail(
					suiPluginError(
						'fork-impersonate',
						`sui fork mode: impersonate(${sender}) returned no transaction digest.`,
						raw,
					),
				);
			}
			return { digest, success: !isFailedTransaction(raw), raw };
		}),
});

const readForkStatus = (sdkClient: SuiGrpcClient): Effect.Effect<ForkStatus, SuiPluginError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await sdkClient.forkingService.getStatus({}).response;
			return {
				checkpoint: response.checkpointSequenceNumber.toString(),
				clock: Number(response.timestampMs),
				forkedAtCheckpoint: response.forkedAtCheckpoint.toString(),
			};
		},
		catch: (cause) =>
			suiPluginError(
				'fork-status-probe',
				`sui fork mode: GetStatus failed: ${stringifyCause(cause)}`,
				cause,
			),
	});

const routedSuiRpcUrl = (identity: Identity): Effect.Effect<string, SuiPluginError> =>
	routerHostname(identity, SUI_RPC_ENDPOINT_NAME).pipe(
		Effect.map((hostname) =>
			renderUrl({ protocol: 'http', hostname, port: SUI_RPC_ENTRYPOINT_PORT }),
		),
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui fork mode: failed to construct router RPC URL: ${cause.detail}`,
				cause,
			),
		),
	);

const extractExecuteDigest = (raw: unknown): string | undefined => {
	const env = raw as {
		readonly $kind?: 'Transaction' | 'FailedTransaction';
		readonly Transaction?: { readonly digest?: string };
		readonly FailedTransaction?: { readonly digest?: string };
	};
	return env.$kind === 'FailedTransaction'
		? env.FailedTransaction?.digest
		: env.Transaction?.digest;
};

const isFailedTransaction = (raw: unknown): boolean =>
	(raw as { readonly $kind?: string }).$kind === 'FailedTransaction';

