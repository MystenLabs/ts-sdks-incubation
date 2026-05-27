// Sui plugin — local-container mode.
//
// In-stack Sui validator + faucet, running in the supervised docker
// stack. Used during normal dev loops when the developer wants fresh,
// fast, throwaway chain state with a working faucet.
//
// Boot sequence (load-bearing order):
//
//   1. Resolve image — vendored Dockerfile build via the
//      ContainerRuntime contract (caller `image` override honoured for
//      `{build}`; `{pull}` is deferred — see stub list in the README).
//   2. Allocate + ensure container — `sui start --with-faucet=0.0.0.0:9123
//      --with-graphql=0.0.0.0:9125` with direct host port-publishing
//      for internal boot probes. User-facing URLs are router-fronted
//      named hosts; the direct host ports intentionally live in the
//      high private windows so they do not collide with router
//      entrypoints.
//      RecreatePolicy is `on-failure` so the writable layer (chain
//      state at `/root/.sui`) survives clean stop/start cycles, but an
//      unclean SIGKILL/137 exit recreates instead of resuming a suspect
//      RocksDB/checkpoint state. The image's entrypoint forwards SIGINT
//      to a non-PID-1 sui child so clean shutdown (RocksDB checkpoint
//      drain → exit 0/130) is the normal case.
//   3. Ready probe — RPC `getChainIdentifier`, faucet `GET /`, and
//      GraphQL HTTP liveness. Per-fetch deadline + outer deadline.
//   4. Fetch chain id from the now-responsive client (bounded timeout).
//   5. Build `waitForTransactionsReady` — `Effect.cached` against a
//      real faucet funding tx; first failure caches for the scope.
//      Manual `invalidate` clears the memo.
//   6. Return resolved `SuiClient`. Auto-tick is the no-op advancer
//      (localnet drives its own consensus).
//
// Faucet socket-level readiness does NOT imply funds-transferability.
// The first `waitForTransactionsReady.wait` POSTs a real funding tx,
// retrying on body-level `{Failure}` responses during the post-RPC /
// pre-fund window.
//
// What this body deliberately defers:
//   - Postgres indexer sidecar — GraphQL is enabled by `sui start` and
//     routed as a first-class endpoint, but no separate postgres
//     lifecycle is supervised here.
//   - Snapshot capture — the framework exists in the plugin's
//     snapshot.ts; this body produces the running container that the
//     orchestrator captures.

import { Duration, Effect, type Scope } from 'effect';

import { SuiGrpcClient } from '@mysten/sui/grpc';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
	ContainerPortPublish,
	PortBindingReconciliation,
} from '../../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import type { Identity } from '../../../substrate/identity.ts';
import type {
	AllocatedPort,
	PortBroker,
} from '../../../substrate/runtime/port-broker/index.ts';
import { waitForHttpEndpoint } from '../../../substrate/runtime/http-probe.ts';
import { setCurrentPluginPhase } from '../../../substrate/runtime/current-plugin.ts';
import { ensureManagedContainer } from '../../../substrate/runtime/managed-container.ts';
import { SpanAttr } from '../../../substrate/runtime/observability/spans.ts';
import { renderUrl, routerHostname } from '../../../orchestrators/router/hostname.ts';
import {
	DEFAULT_SUI_CLI_VERSION,
	suiCliImageBuildContext,
} from '../../../substrate/runtime/sui-move-build/index.ts';
import { noopClockAdvancer } from '../auto-tick.ts';
import { suiPluginError, type SuiPluginError } from '../errors.ts';
import { stringifyCause } from '../stringify-cause.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import { SuiSpans } from '../spans.ts';
import {
	SUI_FAUCET_ENTRYPOINT_PORT,
	SUI_FAUCET_ENDPOINT_NAME,
	SUI_GRAPHQL_ENDPOINT_NAME,
	SUI_GRAPHQL_ENTRYPOINT_PORT,
	SUI_RPC_ENDPOINT_NAME,
	SUI_RPC_ENTRYPOINT_PORT,
} from '../routable.ts';
import type { SuiClient } from './shared.ts';
import { toDockerHostGatewayUrl } from './shared.ts';
import {
	assembleSuiClient,
	buildWaitForTransactionsReady,
	fetchChainId as sharedFetchChainId,
	makeResolvedNetwork,
} from './shared-boot.ts';
import type { SuiLocalOptions } from './spec.ts';

/** Default ready-probe timeout for localnet. The validator's cold
 *  start runs genesis + faucet bootstrap; 60 s is the documented
 *  ceiling. */
export const DEFAULT_LOCAL_READY_TIMEOUT = Duration.seconds(60);

/** Default sui validator binary version pinned by the vendored
 *  `images/sui/` Dockerfile. The build arg `SUI_VERSION` is threaded
 *  through to the release-tarball URL. Bump in lockstep with matching
 *  Walrus / Seal versions (else the Move package ABIs drift). */
export const DEFAULT_SUI_VERSION = DEFAULT_SUI_CLI_VERSION;

// In-container ports the sui binary binds on. These match the router
// entrypoint ports; direct host publishes below use different high
// ports so Traefik owns the public listener ports.
const CONTAINER_RPC_PORT = SUI_RPC_ENTRYPOINT_PORT;
const CONTAINER_FAUCET_PORT = SUI_FAUCET_ENTRYPOINT_PORT;
const CONTAINER_GRAPHQL_PORT = SUI_GRAPHQL_ENTRYPOINT_PORT;

// Default host ports. Without `opts.ports`, these are preferences
// brokered against the kernel before Docker publishes them.
export const DEFAULT_HOST_RPC_PORT = 51000;
export const DEFAULT_HOST_FAUCET_PORT = 50000;
export const DEFAULT_HOST_GRAPHQL_PORT = 51001;
const DOCKER_PUBLISH_HOST = '0.0.0.0' as const;
export const MAX_DOCKER_PUBLISH_PORT_RETRIES = 3;
export const LOCAL_VALIDATOR_STOP_GRACE_SECONDS = 30;

/** Per-fetch deadline for the ready-probe HTTP calls. Without it a
 *  hung fetch would block the outer ready deadline with no signal
 *  about which probe wedged. */
const PROBE_FETCH_TIMEOUT_MS = 3000;

/** Resolved local-mode boot artifacts. */
export interface LocalModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
	readonly clockAdvancer: typeof noopClockAdvancer;
}

/**
 * Build the local-mode boot Effect.
 *
 * `identity` is threaded in by the caller (the plugin barrel's acquire
 * body, which has access to the substrate's `IdentityContext` via the
 * outer composition layer); the body uses it to stamp the canonical
 * container label tuple so sweep / inventory are name-blind.
 *
 * `{pull}`, `{build}`, and vendored-build image branches are wired.
 */
export const bootLocalMode = (
	runtime: ContainerRuntime,
	identity: Identity,
	portBroker: PortBroker,
	opts: SuiLocalOptions,
): Effect.Effect<LocalModeBootResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// ----- 1. Resolve image ---------------------------------------------
		yield* setCurrentPluginPhase('resolving Sui local image');
		const image = yield* resolveImage(runtime, opts);

		// ----- 2. Allocate ports + ensure container --------------------------
		yield* setCurrentPluginPhase('creating Sui validator container');
		const labels: ContainerLabelTuple = {
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'validator',
		};
		const containerName = `devstack-${identity.app}-${identity.stack}-sui-validator`;
		const { handle, ports } = yield* ensureLocalValidatorContainer(
			runtime,
			portBroker,
			image,
			labels,
			containerName,
			opts,
		);

		// ----- 3. Ready probes ----------------------------------------------
		const publishedPorts = resolvePublishedPortMapping(ports, handle.ports);
		const directRpcUrl = `http://127.0.0.1:${publishedPorts[0]!.hostPort}`;
		const directFaucetUrl = `http://127.0.0.1:${publishedPorts[1]!.hostPort}`;
		const directGraphqlUrl = `http://127.0.0.1:${publishedPorts[2]!.hostPort}`;
		const rpcUrl = yield* routedSuiUrl(identity, SUI_RPC_ENDPOINT_NAME, SUI_RPC_ENTRYPOINT_PORT);
		const faucetUrl = yield* routedSuiUrl(
			identity,
			SUI_FAUCET_ENDPOINT_NAME,
			SUI_FAUCET_ENTRYPOINT_PORT,
		);
		const graphqlUrl = yield* routedSuiUrl(
			identity,
			SUI_GRAPHQL_ENDPOINT_NAME,
			SUI_GRAPHQL_ENTRYPOINT_PORT,
		);
		const readyTimeout = opts.readyTimeout ?? DEFAULT_LOCAL_READY_TIMEOUT;

		yield* setCurrentPluginPhase('waiting for Sui RPC, faucet, and GraphQL');
		yield* waitForReady(directRpcUrl, directFaucetUrl, directGraphqlUrl, readyTimeout).pipe(
			Effect.annotateLogs({ [SuiSpans.container]: handle.name }),
		);

		const sdkClient = new SuiGrpcClient({ baseUrl: directRpcUrl, network: 'localnet' });

		// ----- 4. Resolve chain id ------------------------------------------
		yield* setCurrentPluginPhase('fetching Sui chain id');
		const chain = yield* sharedFetchChainId(sdkClient, {
			span: 'devstack.plugin.sui.local.fetchChainId',
		});

		// ----- 5. waitForTransactionsReady (memoised) -----------------------
		yield* setCurrentPluginPhase('preparing Sui funds-ready gate');
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(directFaucetUrl);

		// ----- 6. Assemble resolved SuiClient -------------------------------
		// Surface `buildImage` so package's path-(b) `docker run --rm`
		// build path can spawn a one-shot sui-cli container using the
		// SAME image we built/resolved here. Without this the package
		// plugin would have to re-resolve the image, doubling the
		// build-context hash work and risking digest drift.
		const { client } = assembleSuiClient({
			sdkClient,
			chain,
			rpcUrl,
			faucetUrl,
			fundingFaucetUrl: directFaucetUrl,
			graphqlUrl,
			waitForTransactionsReady,
			buildImage: image,
			hostGateway: {
				rpcUrl: toDockerHostGatewayUrl(directRpcUrl),
				faucetUrl: toDockerHostGatewayUrl(directFaucetUrl),
				graphqlUrl: toDockerHostGatewayUrl(directGraphqlUrl),
			},
		});
		const resolved = makeResolvedNetwork({
			mode: 'local',
			chain,
			rpc: rpcUrl,
			faucet: faucetUrl,
			graphql: graphqlUrl,
			source: 'default',
		});
		return {
			resolved,
			client,
			clockAdvancer: noopClockAdvancer,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.local.boot', { attributes: { [SpanAttr.plugin]: 'sui' } }),
	);

// ---------------------------------------------------------------------------
// Image resolution — vendored Dockerfile build via `ContainerRuntime`
// ---------------------------------------------------------------------------

export const resolveImage = (
	runtime: ContainerRuntime,
	opts: SuiLocalOptions,
): Effect.Effect<ImageRef, SuiPluginError> =>
	Effect.gen(function* () {
		if (opts.image && 'pull' in opts.image) {
			const pullRef = opts.image.pull;
			if (runtime.pullImage === undefined) {
				return yield* Effect.fail(
					suiPluginError(
						'image-build',
						`sui local mode cannot pull image '${pullRef}' because the configured container runtime does not expose image pulls.`,
					),
				);
			}
			return yield* runtime
				.pullImage(pullRef)
				.pipe(
					Effect.mapError((cause) =>
						suiPluginError(
							'image-build',
							`sui local mode failed to pull image '${pullRef}': ${cause.reason}: ${cause.detail}`,
							cause,
						),
					),
				);
		}
		const version = opts.version ?? DEFAULT_SUI_VERSION;
		const buildCtx =
			opts.image && 'build' in opts.image
				? {
						contextPath: opts.image.build.context,
						dockerfile: opts.image.build.dockerfile ?? 'Dockerfile',
						buildArgs: { SUI_VERSION: version },
					}
				: suiCliImageBuildContext(version);
		return yield* runtime
			.ensureImage(buildCtx)
			.pipe(
				Effect.mapError((cause) =>
					suiPluginError(
						'image-build',
						`sui image build failed: ${cause.reason}: ${cause.detail}`,
						cause,
					),
				),
			);
	}).pipe(Effect.withSpan('devstack.plugin.sui.local.resolveImage'));

interface LocalValidatorContainerResult {
	readonly handle: ContainerHandle;
	readonly ports: ReadonlyArray<ContainerPortPublish>;
}

interface ResolvedPortMapping {
	readonly ports: ReadonlyArray<ContainerPortPublish>;
	readonly release: Effect.Effect<void>;
}

export const ensureLocalValidatorContainer = (
	runtime: ContainerRuntime,
	portBroker: PortBroker,
	image: ImageRef,
	labels: ContainerLabelTuple,
	containerName: string,
	opts: SuiLocalOptions,
): Effect.Effect<LocalValidatorContainerResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const reusablePorts =
			opts.ports === undefined
				? yield* findReusablePortMapping(runtime, labels, containerName)
				: undefined;
		if (reusablePorts !== undefined) {
			return yield* ensureLocalValidatorContainerAttempt({
				runtime,
				portBroker,
				image,
				labels,
				containerName,
				opts,
				ports: reusablePorts,
				attempt: 0,
				reconciliation: 'adopt-existing',
			});
		}
		return yield* ensureLocalValidatorContainerWithFreshPorts({
			runtime,
			portBroker,
			image,
			labels,
			containerName,
			opts,
			attempt: 0,
			reconciliation: opts.ports ? 'exact' : 'adopt-existing',
		});
	});

interface EnsureLocalValidatorContainerBase {
	readonly runtime: ContainerRuntime;
	readonly portBroker: PortBroker;
	readonly image: ImageRef;
	readonly labels: ContainerLabelTuple;
	readonly containerName: string;
	readonly opts: SuiLocalOptions;
}

const ensureLocalValidatorContainerWithFreshPorts = (
	params: EnsureLocalValidatorContainerBase & {
		readonly attempt: number;
		readonly reconciliation: PortBindingReconciliation;
	},
): Effect.Effect<LocalValidatorContainerResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const mapping = yield* resolvePortMappingWithRelease(params.portBroker, params.opts.ports);
		return yield* ensureLocalValidatorContainerAttempt({
			...params,
			ports: mapping.ports,
			releasePorts: mapping.release,
		});
	});

const ensureLocalValidatorContainerAttempt = (
	params: EnsureLocalValidatorContainerBase & {
		readonly ports: ReadonlyArray<ContainerPortPublish>;
		readonly releasePorts?: Effect.Effect<void>;
		readonly attempt: number;
		readonly reconciliation: PortBindingReconciliation;
	},
): Effect.Effect<LocalValidatorContainerResult, SuiPluginError, Scope.Scope> =>
	ensureManagedContainer({
		runtime: params.runtime,
		labels: params.labels,
		spec: {
			name: params.containerName,
			image: params.image,
			// Keep the writable layer only after clean exits. If Docker
			// escalates a previous stop to SIGKILL (137), resume can hang
			// in RocksDB/checkpoint recovery with no RPC/faucet probes.
			// `on-failure` routes that stale layer to recreate while still
			// warm-resuming normal exit 0 / 130 stops. The longer grace
			// gives the entrypoint's SIGINT forwarding time to drain.
			recreate: 'on-failure',
			stopGraceSeconds: LOCAL_VALIDATOR_STOP_GRACE_SECONDS,
			ports: params.ports,
			portBindingReconciliation: params.reconciliation,
		},
		mapError: (cause) => cause,
	}).pipe(
		Effect.map((handle) => ({ handle, ports: params.ports })),
		Effect.catch((cause: ContainerRuntimeError) => {
			if (
				params.opts.ports === undefined &&
				cause.reason === 'publish-port-conflict' &&
				params.attempt < MAX_DOCKER_PUBLISH_PORT_RETRIES
			) {
				return (params.releasePorts ?? Effect.void).pipe(
					Effect.andThen(
						ensureLocalValidatorContainerWithFreshPorts({
							...params,
							attempt: params.attempt + 1,
							reconciliation: 'exact',
						}),
					),
				);
			}
			return Effect.fail(
				suiPluginError(
					'container-start',
					`sui-validator container failed: ${cause.reason}: ${cause.detail}`,
					cause,
				),
			);
		}),
	);

// ---------------------------------------------------------------------------
// Port mapping — host:container pairs
// ---------------------------------------------------------------------------

export const resolvePortMapping = (
	portBroker: PortBroker,
	override: Readonly<Record<number, number>> | undefined,
): Effect.Effect<ReadonlyArray<ContainerPortPublish>, SuiPluginError, Scope.Scope> =>
	resolvePortMappingWithRelease(portBroker, override).pipe(Effect.map((mapping) => mapping.ports));

const resolvePortMappingWithRelease = (
	portBroker: PortBroker,
	override: Readonly<Record<number, number>> | undefined,
): Effect.Effect<ResolvedPortMapping, SuiPluginError, Scope.Scope> => {
	const pick = (containerPort: number, fallback: number): number => {
		if (!override) return fallback;
		const hit = override[containerPort];
		return typeof hit === 'number' ? hit : fallback;
	};
	if (override) {
		return Effect.succeed({
			ports: [
				portPublish(CONTAINER_RPC_PORT, pick(CONTAINER_RPC_PORT, DEFAULT_HOST_RPC_PORT)),
				portPublish(CONTAINER_FAUCET_PORT, pick(CONTAINER_FAUCET_PORT, DEFAULT_HOST_FAUCET_PORT)),
				portPublish(
					CONTAINER_GRAPHQL_PORT,
					pick(CONTAINER_GRAPHQL_PORT, DEFAULT_HOST_GRAPHQL_PORT),
				),
			],
			release: Effect.void,
		});
	}
	return Effect.gen(function* () {
		const rpc = yield* allocatePort(portBroker, 'sui:rpc', DEFAULT_HOST_RPC_PORT, 'rpc');
		const faucet = yield* allocatePort(portBroker, 'sui:faucet', DEFAULT_HOST_FAUCET_PORT, 'faucet');
		const graphql = yield* allocatePort(
			portBroker,
			'sui:graphql',
			DEFAULT_HOST_GRAPHQL_PORT,
			'graphql',
		);
		return {
			ports: [
				portPublish(CONTAINER_RPC_PORT, rpc.port),
				portPublish(CONTAINER_FAUCET_PORT, faucet.port),
				portPublish(CONTAINER_GRAPHQL_PORT, graphql.port),
			],
			release: Effect.all([rpc.release, faucet.release, graphql.release], { discard: true }),
		};
	});
};

export const resolvePublishedPortMapping = (
	requested: ReadonlyArray<ContainerPortPublish>,
	actual: ReadonlyArray<ContainerPortPublish> | undefined,
): ReadonlyArray<ContainerPortPublish> => [
	pickPublishedPort(requested, actual, CONTAINER_RPC_PORT, DEFAULT_HOST_RPC_PORT),
	pickPublishedPort(requested, actual, CONTAINER_FAUCET_PORT, DEFAULT_HOST_FAUCET_PORT),
	pickPublishedPort(requested, actual, CONTAINER_GRAPHQL_PORT, DEFAULT_HOST_GRAPHQL_PORT),
];

const pickPublishedPort = (
	requested: ReadonlyArray<ContainerPortPublish>,
	actual: ReadonlyArray<ContainerPortPublish> | undefined,
	containerPort: number,
	fallbackHostPort: number,
): ContainerPortPublish =>
	actual?.find((port) => port.containerPort === containerPort) ??
	requested.find((port) => port.containerPort === containerPort) ??
	portPublish(containerPort, fallbackHostPort);

export const selectReusablePortMapping = (
	handles: ReadonlyArray<ContainerHandle>,
	containerName: string,
): ReadonlyArray<ContainerPortPublish> | undefined => {
	const ports = handles.find((handle) => handle.name === containerName)?.ports;
	if (!hasSuiPortMapping(ports)) return undefined;
	return resolvePublishedPortMapping([], ports);
};

const findReusablePortMapping = (
	runtime: ContainerRuntime,
	labels: ContainerLabelTuple,
	containerName: string,
): Effect.Effect<ReadonlyArray<ContainerPortPublish> | undefined, SuiPluginError> =>
	runtime.inspectByLabels(labels).pipe(
		Effect.map((handles) => selectReusablePortMapping(handles, containerName)),
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui local mode: failed to inspect existing validator container: ${cause.reason}: ${cause.detail}`,
				cause,
			),
		),
	);

const hasSuiPortMapping = (
	ports: ReadonlyArray<ContainerPortPublish> | undefined,
): ports is ReadonlyArray<ContainerPortPublish> =>
	ports !== undefined &&
	ports.some((port) => port.containerPort === CONTAINER_RPC_PORT) &&
	ports.some((port) => port.containerPort === CONTAINER_FAUCET_PORT) &&
	ports.some((port) => port.containerPort === CONTAINER_GRAPHQL_PORT);

const portPublish = (containerPort: number, hostPort: number): ContainerPortPublish => ({
	containerPort,
	hostPort,
	hostIp: DOCKER_PUBLISH_HOST,
});

const allocatePort = (
	portBroker: PortBroker,
	owner: string,
	preferredPort: number | undefined,
	label: 'rpc' | 'faucet' | 'graphql',
): Effect.Effect<AllocatedPort, SuiPluginError, Scope.Scope> => {
	const allocate = (
		hint: number | undefined,
	): Effect.Effect<AllocatedPort, SuiPluginError, Scope.Scope> =>
		portBroker
			.allocate({
				owner,
				...(hint === undefined ? {} : { preferredPort: hint }),
				probeHost: DOCKER_PUBLISH_HOST,
			})
			.pipe(
				Effect.catchTag('PortBrokerError', (cause) =>
					hint !== undefined && cause.reason === 'preferred-busy'
						? portBroker.allocate({ owner, probeHost: DOCKER_PUBLISH_HOST })
						: Effect.fail(cause),
				),
				Effect.mapError((cause) =>
					suiPluginError(
						'port-allocate',
						`sui local mode: failed to allocate ${label} host port ` +
							`(preferred ${hint ?? 'auto'}): ${cause.detail}`,
						cause,
					),
				),
			);
	return allocate(preferredPort);
};

// ---------------------------------------------------------------------------
// Ready-probe coordination
// ---------------------------------------------------------------------------

/** Coordinated readiness gate. Both RPC + faucet must respond within
 *  the outer deadline; each probe has its own per-fetch deadline so a
 *  wedged endpoint surfaces by name. */
const waitForReady = (
	rpcUrl: string,
	faucetUrl: string,
	graphqlUrl: string,
	readyTimeout: Duration.Duration,
): Effect.Effect<void, SuiPluginError> =>
	Effect.gen(function* () {
		const readyTimeoutMs = Duration.toMillis(readyTimeout);
		const rpcProbe: Effect.Effect<void, SuiPluginError> = waitForHttpEndpoint({
			endpoint: rpcUrl,
			timeoutMs: readyTimeoutMs,
			intervalMs: 1_000,
			requestTimeoutMs: PROBE_FETCH_TIMEOUT_MS,
			requestInit: {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'sui_getLatestCheckpointSequenceNumber',
					params: [],
				}),
			},
			validate: async (response) => {
				if (!response.ok) return false;
				const body = (await response.json()) as { readonly result?: unknown };
				return typeof body.result === 'string' || typeof body.result === 'number';
			},
		}).pipe(
			Effect.mapError(
				(cause): SuiPluginError =>
					suiPluginError(
						'rpc-probe',
						`sui local mode: RPC endpoint ${rpcUrl} did not become ready within ` +
							`${readyTimeoutMs}ms: ${stringifyCause(cause)}`,
						cause,
					),
			),
			Effect.withSpan('devstack.plugin.sui.local.probe.rpc'),
		);

		// Faucet socket-level liveness — `GET /` returns "OK" as soon as
		// the HTTP server is bound. We do NOT POST `/v2/gas` here; that's
		// the funds-ready probe, which is paid for lazily on first call.
		const faucetProbe: Effect.Effect<void, SuiPluginError> = waitForHttpEndpoint({
			endpoint: faucetUrl,
			timeoutMs: readyTimeoutMs,
			intervalMs: 1_000,
			requestTimeoutMs: PROBE_FETCH_TIMEOUT_MS,
			validate: (response) => response.status < 500,
		}).pipe(
			Effect.mapError(
				(cause): SuiPluginError =>
					suiPluginError(
						'faucet-probe',
						`sui local mode: faucet endpoint ${faucetUrl} did not become ready within ` +
							`${readyTimeoutMs}ms: ${stringifyCause(cause)}`,
						cause,
					),
			),
			Effect.withSpan('devstack.plugin.sui.local.probe.faucet'),
		);

		const graphqlProbe: Effect.Effect<void, SuiPluginError> = waitForHttpEndpoint({
			endpoint: graphqlUrl,
			timeoutMs: readyTimeoutMs,
			intervalMs: 1_000,
			requestTimeoutMs: PROBE_FETCH_TIMEOUT_MS,
			validate: (response) => response.status < 500,
		}).pipe(
			Effect.mapError(
				(cause): SuiPluginError =>
					suiPluginError(
						'graphql-probe',
						`sui local mode: GraphQL endpoint ${graphqlUrl} did not become ready within ` +
							`${readyTimeoutMs}ms: ${stringifyCause(cause)}`,
						cause,
					),
			),
			Effect.withSpan('devstack.plugin.sui.local.probe.graphql'),
		);

		yield* Effect.all([rpcProbe, faucetProbe, graphqlProbe], { concurrency: 'unbounded' }).pipe(
			Effect.asVoid,
		);
	}).pipe(Effect.withSpan('devstack.plugin.sui.local.waitForReady'));

// Chain-id fetch + waitForTransactionsReady builders live in
// `shared-boot.ts` — see imports at the top of this file.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const routedSuiUrl = (
	identity: Identity,
	endpointName: string,
	port: number,
): Effect.Effect<string, SuiPluginError> =>
	routerHostname(identity, endpointName).pipe(
		Effect.map((hostname) => renderUrl({ protocol: 'http', hostname, port })),
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui local mode: failed to construct router URL for ${endpointName}: ${cause.detail}`,
				cause,
			),
		),
	);

