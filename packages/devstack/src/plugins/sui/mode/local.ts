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
// GraphQL indexer (on by default):
//   - The sui-tools base ships no embedded Postgres, so `--with-graphql`
//     reads from a separate DB. By default the sui plugin OWNS that DB as
//     a postgres SIDECAR (provisioned in the barrel before this body
//     runs); the caller can instead BYO a Postgres, or opt out entirely.
//     Either way this body receives a resolved `{ url, network }`
//     (`undefined` when indexer is off), attaches the validator to that
//     network, and passes the DSN in via `DEVSTACK_SUI_INDEXER_URL` so
//     the entrypoint appends `--with-graphql` + `--with-indexer=<dsn>`.
//
// What this body deliberately defers:
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
import type { AllocatedPort, PortBroker } from '../../../substrate/runtime/port-broker/index.ts';
import { waitForHttpEndpoint } from '../../../substrate/runtime/http-probe.ts';
import { waitForProbe } from '../../../substrate/runtime/probes.ts';
import { setCurrentPluginPhase } from '../../../substrate/runtime/current-plugin.ts';
import { ensureManagedContainer } from '../../../substrate/runtime/managed-container.ts';
import { SpanAttr } from '../../../substrate/runtime/observability/spans.ts';
import { renderUrl, routedHostname } from '../../../substrate/runtime/routed-url.ts';
import { suiCliImageBuildContext } from '../move/index.ts';
import { suiPluginError, type SuiConfigError, type SuiPluginError } from '../errors.ts';
import { formatUnknownError } from '../../../substrate/runtime/format-unknown-error.ts';
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

/** Default ready-probe timeout for localnet.
 *
 *  This budget covers TWO bands, because the ready-gate proves
 *  caught-up-to-head, not just RPC-bound:
 *
 *    - cold boot — genesis + faucet bootstrap; nothing to re-sync, so the
 *      catch-up gate is satisfied almost immediately.
 *    - warm restart / snapshot restore — the VALIDATOR resumes from its
 *      persisted db instantly (stable committee key), but `sui start`
 *      mints the embedded FULLNODE a fresh keypair + db-path on every
 *      invocation (it never reuses the saved fullnode.yaml), so the
 *      fullnode — which serves this RPC — boots with an empty db and
 *      re-syncs the whole chain from genesis (~50x realtime; a multi-
 *      thousand-checkpoint chain takes 60-120s). The catch-up gate waits
 *      for that fullnode re-sync, not a validator replay. (Upstream fix
 *      proposed to make `sui start` resume a stable fullnode — see
 *      sui-swarm-config node_config_builder.rs; until then the re-sync is
 *      intrinsic to a localnet restart.)
 *
 *  60s was a genesis-sized ceiling; it gives up mid-resync on a restore.
 *  180s covers the re-sync band with margin while still bounding a wedged
 *  boot (timeout → typed `rpc-probe` error). */
export const DEFAULT_LOCAL_READY_TIMEOUT = Duration.seconds(180);

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

/** Role label for sui's owned GraphQL-indexer postgres sidecar. Shared
 *  const so the container label (in `bootPostgresSidecar`'s caller) and
 *  the snapshotable capture tuple agree exactly. */
export const SUI_INDEXER_DB_ROLE = 'indexer-db' as const;

/** Resolved indexer wiring for local mode. The URL is the PostgreSQL DSN
 *  (sui-owned sidecar by default, or the caller's BYO DB); `network` is
 *  the container network the validator joins to reach it. */
export interface LocalIndexer {
	readonly url: string;
	readonly network: string;
}

/** Resolved local-mode boot artifacts. */
export interface LocalModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
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
	indexer: LocalIndexer | undefined,
): Effect.Effect<LocalModeBootResult, SuiPluginError | SuiConfigError, Scope.Scope> =>
	Effect.gen(function* () {
		// ----- 1. Resolve image ---------------------------------------------
		yield* setCurrentPluginPhase('resolving Sui local image');
		const image = yield* resolveImage(runtime, identity, opts);

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
			indexer,
		);

		// GraphQL is gated on a resolved indexer DB (on by default via the
		// sui-owned sidecar; off when `indexer: false`). Without `indexer`
		// the entrypoint omits `--with-graphql`, so we skip its routed URL +
		// probe and resolve a graphql-less client.
		const graphqlEnabled = indexer !== undefined;

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
		const graphqlUrl = graphqlEnabled
			? yield* routedSuiUrl(identity, SUI_GRAPHQL_ENDPOINT_NAME, SUI_GRAPHQL_ENTRYPOINT_PORT)
			: undefined;
		const readyTimeout = opts.readyTimeout ?? DEFAULT_LOCAL_READY_TIMEOUT;

		yield* setCurrentPluginPhase(
			graphqlEnabled
				? 'waiting for Sui RPC, faucet, and GraphQL'
				: 'waiting for Sui RPC and faucet',
		);
		yield* waitForReady(
			directRpcUrl,
			directFaucetUrl,
			graphqlEnabled ? directGraphqlUrl : undefined,
			readyTimeout,
		).pipe(Effect.annotateLogs({ [SuiSpans.container]: handle.name }));

		// Caught-up-to-head gate. `waitForReady` only proves the RPC
		// listener is BOUND. On a warm restart / snapshot restore the
		// validator resumes from its persisted db instantly, but the
		// embedded fullnode that serves this RPC gets a fresh key + empty
		// db each `sui start` (see DEFAULT_LOCAL_READY_TIMEOUT) and
		// re-syncs the chain from seq=0 (~50x realtime); during that
		// re-sync it serves stale / not-yet-existent objects, so downstream
		// deploy-verify probes that run before catch-up read their
		// committed ids as not-found and spuriously re-deploy with fresh
		// ids. Wait once here, per boot, until the checkpoint head
		// stabilizes to live cadence — so every downstream verify runs
		// against a fullnode that already serves the committed state. On a
		// cold/genesis boot there is nothing to re-sync and this satisfies
		// almost immediately.
		yield* setCurrentPluginPhase('waiting for Sui checkpoint replay to catch up to head');
		yield* waitForCheckpointCatchUp(directRpcUrl, readyTimeout).pipe(
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
		const { client } = yield* assembleSuiClient({
			sdkClient,
			chain,
			rpcUrl,
			faucetUrl,
			fundingFaucetUrl: directFaucetUrl,
			...(graphqlUrl !== undefined ? { graphqlUrl } : {}),
			waitForTransactionsReady,
			buildImage: image,
			hostGateway: {
				rpcUrl: toDockerHostGatewayUrl(directRpcUrl),
				faucetUrl: toDockerHostGatewayUrl(directFaucetUrl),
				graphqlUrl: graphqlEnabled ? toDockerHostGatewayUrl(directGraphqlUrl) : null,
			},
		});
		const resolved = makeResolvedNetwork({
			mode: 'local',
			chain,
			rpc: rpcUrl,
			faucet: faucetUrl,
			...(graphqlUrl !== undefined ? { graphql: graphqlUrl } : {}),
			source: 'default',
		});
		return {
			resolved,
			client,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.local.boot', { attributes: { [SpanAttr.plugin]: 'sui' } }),
	);

// ---------------------------------------------------------------------------
// Image resolution — vendored Dockerfile build via `ContainerRuntime`
// ---------------------------------------------------------------------------

export const resolveImage = (
	runtime: ContainerRuntime,
	identity: Identity,
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
		const owner = {
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'validator',
		} as const;
		const vendored = suiCliImageBuildContext();
		const buildCtx =
			opts.image && 'build' in opts.image
				? {
						contextPath: opts.image.build.context,
						dockerfile: opts.image.build.dockerfile ?? 'Dockerfile',
						buildArgs: vendored.buildArgs,
						owner,
					}
				: { ...vendored, owner };
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
	indexer: LocalIndexer | undefined,
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
				indexer,
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
			indexer,
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
	readonly indexer: LocalIndexer | undefined;
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
			// gives the entrypoint time to flush RocksDB on stop.
			recreate: 'on-failure',
			stopGraceSeconds: LOCAL_VALIDATOR_STOP_GRACE_SECONDS,
			ports: params.ports,
			portBindingReconciliation: params.reconciliation,
			// Indexer (when on): join the indexer DB's network + hand the
			// entrypoint the DSN so it enables `--with-graphql` against it
			// (sui-owned sidecar by default, or a BYO DB). Omitted = RPC +
			// faucet only.
			...(params.indexer !== undefined
				? {
						networkAttach: [params.indexer.network],
						env: { DEVSTACK_SUI_INDEXER_URL: params.indexer.url },
					}
				: {}),
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

// Exported test entry point: resolves the host:container port pairs
// without surfacing the release handle (the live boot path uses
// `resolvePortMappingWithRelease` directly to retain the release).
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
		const faucet = yield* allocatePort(
			portBroker,
			'sui:faucet',
			DEFAULT_HOST_FAUCET_PORT,
			'faucet',
		);
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

/** Coordinated readiness gate. RPC + faucet must respond within the
 *  outer deadline; GraphQL is probed only when enabled (gated on the
 *  external indexer). Each probe has its own per-fetch deadline so a
 *  wedged endpoint surfaces by name. */
const waitForReady = (
	rpcUrl: string,
	faucetUrl: string,
	graphqlUrl: string | undefined,
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
							`${readyTimeoutMs}ms: ${formatUnknownError(cause)}`,
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
							`${readyTimeoutMs}ms: ${formatUnknownError(cause)}`,
						cause,
					),
			),
			Effect.withSpan('devstack.plugin.sui.local.probe.faucet'),
		);

		const graphqlProbe: ReadonlyArray<Effect.Effect<void, SuiPluginError>> =
			graphqlUrl === undefined
				? []
				: [
						waitForHttpEndpoint({
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
											`${readyTimeoutMs}ms: ${formatUnknownError(cause)}`,
										cause,
									),
							),
							Effect.withSpan('devstack.plugin.sui.local.probe.graphql'),
						),
					];

		yield* Effect.all([rpcProbe, faucetProbe, ...graphqlProbe], { concurrency: 'unbounded' }).pipe(
			Effect.asVoid,
		);
	}).pipe(Effect.withSpan('devstack.plugin.sui.local.waitForReady'));

// ---------------------------------------------------------------------------
// Caught-up-to-head gate
// ---------------------------------------------------------------------------

/** Poll interval for the checkpoint catch-up gate. Replay runs ~50x
 *  realtime (hundreds of checkpoints per second); a 1s interval samples
 *  a large enough window to tell replay cadence (hundreds/poll) apart
 *  from live cadence (a handful/poll). */
const CATCH_UP_POLL_INTERVAL_MS = 1_000;

/** Per-poll delta at or below which the head is considered to be moving
 *  at LIVE cadence rather than fast-replay cadence. Localnet's narwhal/
 *  bullshark consensus produces only a few checkpoints per second when
 *  idle; replay produces hundreds per `CATCH_UP_POLL_INTERVAL_MS`. A
 *  threshold of 25 sits well above live idle cadence and far below the
 *  replay rate, so it cannot mistake live ticking for replay. */
const CATCH_UP_LIVE_CADENCE_DELTA = 25;

/** Number of CONSECUTIVE live-cadence polls required before declaring
 *  caught-up. Two consecutive small deltas rules out the moment replay
 *  briefly stalls (e.g. a GC pause) from being read as caught-up: a
 *  paused replay shows one small delta then resumes with a large one,
 *  so it never strings two together. A genuinely caught-up validator
 *  holds small deltas indefinitely. */
const CATCH_UP_STABLE_POLLS_REQUIRED = 2;

/** Fetch the latest checkpoint sequence number via raw JSON-RPC.
 *  Returns the number, or `undefined` when the listener answered but the
 *  result shape was unexpected (treated as "not yet sampleable"). */
const fetchLatestCheckpoint = (
	rpcUrl: string,
): Effect.Effect<number | undefined, unknown> =>
	Effect.tryPromise({
		try: (signal) =>
			globalThis.fetch(rpcUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'sui_getLatestCheckpointSequenceNumber',
					params: [],
				}),
				signal,
			}),
		catch: (cause) => cause,
	}).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: () => response.json() as Promise<{ readonly result?: unknown }>,
				catch: (cause) => cause,
			}),
		),
		Effect.map((body) => {
			const raw = body.result;
			if (typeof raw === 'number') return raw;
			if (typeof raw === 'string') {
				const n = Number(raw);
				return Number.isFinite(n) ? n : undefined;
			}
			return undefined;
		}),
	);

/** One poll's verdict from the catch-up cadence evaluator. */
export type CatchUpVerdict =
	| { readonly caughtUp: true }
	| { readonly caughtUp: false; readonly detail: unknown };

/** Build the stateful cadence evaluator the catch-up gate feeds samples
 *  into. Pure + injectable so the cadence logic is unit-testable without
 *  a live validator. Each `step(sample)` consumes one
 *  `getLatestCheckpointSequenceNumber` reading:
 *
 *    - `undefined` (listener answered, result unparseable) resets the
 *      stability streak.
 *    - the FIRST numeric sample only establishes a baseline (its delta is
 *      `+Infinity`), so the gate always takes at least two samples before
 *      it can declare caught-up — cheap on cold boot, correct on restore.
 *    - a NEGATIVE delta (the head regressed — mid-re-sync / reset) resets
 *      the streak; it is NOT counted as live cadence even though it is
 *      `<= CATCH_UP_LIVE_CADENCE_DELTA`.
 *    - a delta in `[0, CATCH_UP_LIVE_CADENCE_DELTA]` counts toward the
 *      live-cadence streak; a larger delta (fast replay) resets it.
 *    - `CATCH_UP_STABLE_POLLS_REQUIRED` consecutive live-cadence deltas →
 *      caught-up. */
export const makeCatchUpEvaluator = (opts?: {
	readonly liveCadenceDelta?: number;
	readonly stablePollsRequired?: number;
}): {
	readonly step: (sample: number | undefined) => CatchUpVerdict;
	readonly last: () => number | undefined;
} => {
	const liveCadenceDelta = opts?.liveCadenceDelta ?? CATCH_UP_LIVE_CADENCE_DELTA;
	const stablePollsRequired = opts?.stablePollsRequired ?? CATCH_UP_STABLE_POLLS_REQUIRED;
	let previous: number | undefined;
	let stablePolls = 0;
	return {
		step: (sample) => {
			if (sample === undefined) {
				stablePolls = 0;
				return { caughtUp: false, detail: { reason: 'unparseable-checkpoint' } };
			}
			const delta = previous === undefined ? Number.POSITIVE_INFINITY : sample - previous;
			previous = sample;
			// A NEGATIVE delta means the checkpoint sequence REGRESSED (the head
			// went backwards — e.g. an RPC reading a node mid-re-sync, or a
			// reset). That is NOT live cadence: a regression satisfies
			// `<= liveCadenceDelta`, so counting it toward the streak could
			// falsely declare caught-up while the store is still settling. Reset
			// the streak and keep waiting for forward, live-cadence progress.
			if (delta < 0) {
				stablePolls = 0;
				return {
					caughtUp: false,
					detail: { current: sample, delta, stablePolls, regressed: true },
				};
			}
			if (delta <= liveCadenceDelta) {
				stablePolls += 1;
			} else {
				stablePolls = 0;
			}
			if (stablePolls >= stablePollsRequired) return { caughtUp: true };
			return { caughtUp: false, detail: { current: sample, delta, stablePolls } };
		},
		last: () => previous,
	};
};

/** Caught-up-to-head gate.
 *
 *  Polls `sui_getLatestCheckpointSequenceNumber` and treats the
 *  validator as caught up once the per-poll delta drops from the fast
 *  replay rate (hundreds/poll) to live cadence (`<= CATCH_UP_LIVE_
 *  CADENCE_DELTA`/poll) and HOLDS there for `CATCH_UP_STABLE_POLLS_
 *  REQUIRED` consecutive polls. Cold/genesis boots satisfy this almost
 *  immediately (the store is empty, so deltas are live-cadence from the
 *  first sample); warm/restore boots wait out the whole replay.
 *
 *  A wedged boot (RPC bound but head never stabilizing) lapses the outer
 *  deadline → typed `rpc-probe` error rather than hanging forever. */
const waitForCheckpointCatchUp = (
	rpcUrl: string,
	readyTimeout: Duration.Duration,
): Effect.Effect<void, SuiPluginError> =>
	Effect.gen(function* () {
		const readyTimeoutMs = Duration.toMillis(readyTimeout);
		const evaluator = makeCatchUpEvaluator();

		return yield* waitForProbe({
			label: `${rpcUrl} (checkpoint catch-up)`,
			timeoutMs: readyTimeoutMs,
			intervalMs: CATCH_UP_POLL_INTERVAL_MS,
			attemptTimeoutMs: PROBE_FETCH_TIMEOUT_MS,
			probe: () =>
				fetchLatestCheckpoint(rpcUrl).pipe(
					Effect.map((current) => {
						const verdict = evaluator.step(current);
						return verdict.caughtUp ? true : { ready: false, detail: verdict.detail };
					}),
				),
		}).pipe(
			Effect.mapError(
				(cause): SuiPluginError =>
					suiPluginError(
						'rpc-probe',
						`sui local mode: validator did not catch up to checkpoint head within ` +
							`${readyTimeoutMs}ms (last seq=${evaluator.last() ?? 'n/a'}). The checkpoint replay ` +
							`(warm restart / snapshot restore re-executes the committed store from seq=0) ` +
							`never stabilized to live cadence: ${formatUnknownError(cause)}`,
						cause,
					),
			),
			Effect.withSpan('devstack.plugin.sui.local.waitForCheckpointCatchUp'),
		);
	}).pipe(Effect.withSpan('devstack.plugin.sui.local.waitForCheckpointCatchUp.gen'));

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
	routedHostname(identity, endpointName).pipe(
		Effect.map((hostname) => renderUrl({ protocol: 'http', hostname, port })),
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui local mode: failed to construct router URL for ${endpointName}: ${cause.detail}`,
				cause,
			),
		),
	);
