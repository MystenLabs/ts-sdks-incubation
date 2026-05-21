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
//   2. Allocate + ensure container — `sui start --with-faucet=0.0.0.0:9123`
//      with host port-publishing for RPC (preferred 9000) and faucet
//      (preferred 9123). Defaults go through the PortBroker so
//      parallel stacks reassign instead of colliding.
//      RecreatePolicy stays `on-config-change` so the writable layer
//      (chain state at `/root/.sui`) survives across stop/start cycles
//      regardless of how the prior cycle ended; the image's entrypoint
//      now forwards SIGINT to a non-PID-1 sui child so clean shutdown
//      (RocksDB checkpoint drain → exit 0/130) is the normal case.
//   3. Three-budget ready probe — RPC `getChainIdentifier` + faucet
//      `GET /` socket liveness. Per-fetch deadline + outer deadline.
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
//   - Postgres indexer sidecar + GraphQL endpoint — out of scope for
//     this iteration. The plugin doc treats them as load-bearing for
//     downstream consumers (codegen, KnownPackage); we don't.
//   - Traefik routing via the per-stack router — we use direct host
//     port publishing instead. The router lands when the routable
//     contract is wired.
//   - Snapshot capture — the framework exists in the plugin's
//     snapshot.ts; this body produces the running container that the
//     orchestrator captures.

import { Duration, Effect, Ref, Schedule, type Scope } from 'effect';

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
import type { PortBroker, PortKind } from '../../../substrate/runtime/port-broker/index.ts';
import { noopClockAdvancer } from '../auto-tick.ts';
import { suiPluginError, type SuiPluginError } from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import type { SuiClient } from './shared.ts';
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
export const DEFAULT_SUI_VERSION = 'devnet-v1.71.0';

// In-container ports the sui binary binds on. The contract publishes
// host ports directly, no router indirection.
const CONTAINER_RPC_PORT = 9000;
const CONTAINER_FAUCET_PORT = 9123;

// Default host ports. Without `opts.ports`, these are preferences
// brokered against the kernel before Docker publishes them.
export const DEFAULT_HOST_RPC_PORT = 9000;
export const DEFAULT_HOST_FAUCET_PORT = 9123;
const DOCKER_PUBLISH_HOST = '0.0.0.0' as const;
export const MAX_DOCKER_PUBLISH_PORT_RETRIES = 3;

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
		const image = yield* resolveImage(runtime, opts);

		// ----- 2. Allocate ports + ensure container --------------------------
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
		const rpcUrl = `http://127.0.0.1:${publishedPorts[0]!.hostPort}`;
		const faucetUrl = `http://127.0.0.1:${publishedPorts[1]!.hostPort}`;
		const readyTimeout = opts.readyTimeout ?? DEFAULT_LOCAL_READY_TIMEOUT;

		// Construct the SDK client up-front; the RPC probe reuses it for
		// `getChainIdentifier` so the same transport gates downstream calls.
		const sdkClient = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'localnet' });

		yield* waitForReady(faucetUrl, sdkClient, readyTimeout).pipe(
			Effect.annotateLogs({ 'sui.container': handle.name }),
		);

		// ----- 4. Resolve chain id ------------------------------------------
		const chain =
			opts.chainOverride ??
			(yield* sharedFetchChainId(sdkClient, {
				span: 'devstack.plugin.sui.local.fetchChainId',
			}));

		// ----- 5. waitForTransactionsReady (memoised) -----------------------
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);

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
			waitForTransactionsReady,
			buildImage: image,
		});
		const resolved = makeResolvedNetwork({
			mode: 'local',
			chain,
			rpc: rpcUrl,
			faucet: faucetUrl,
			source: 'default',
		});
		return {
			resolved,
			client,
			clockAdvancer: noopClockAdvancer,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.local.boot', { attributes: { 'devstack.plugin': 'sui' } }),
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
				: {
						// Context is `images/` (NOT `images/sui/`) so the
						// Dockerfile can `COPY _shared/signal-forward.sh`
						// from the shared snippet directory. The dockerfile
						// path is relative to the context.
						contextPath: new URL('../../../../images/', import.meta.url).pathname,
						dockerfile: 'sui/Dockerfile',
						buildArgs: { SUI_VERSION: version },
					};
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
		const ports = yield* resolvePortMapping(params.portBroker, params.opts.ports);
		return yield* ensureLocalValidatorContainerAttempt({ ...params, ports });
	});

const ensureLocalValidatorContainerAttempt = (
	params: EnsureLocalValidatorContainerBase & {
		readonly ports: ReadonlyArray<ContainerPortPublish>;
		readonly attempt: number;
		readonly reconciliation: PortBindingReconciliation;
	},
): Effect.Effect<LocalValidatorContainerResult, SuiPluginError, Scope.Scope> =>
	params.runtime
		.ensureContainer({
			name: params.containerName,
			image: params.image,
			labels: params.labels,
			// `on-config-change` keeps the writable layer (chain state
			// at `/root/.sui`) across stop/start cycles so warm-resume
			// keeps the deployed packages + minted coins + state. The
			// image's entrypoint forwards SIGINT to a non-PID-1 sui
			// child so clean shutdown (exit 0 / 130 with RocksDB
			// checkpoint drain) is the normal case — see entrypoint
			// header for the upstream signal-handler bug it works
			// around.
			recreate: 'on-config-change',
			ports: params.ports,
			portBindingReconciliation: params.reconciliation,
		})
		.pipe(
			Effect.map((handle) => ({ handle, ports: params.ports })),
			Effect.catch((cause: ContainerRuntimeError) => {
				if (
					params.opts.ports === undefined &&
					cause.reason === 'publish-port-conflict' &&
					params.attempt < MAX_DOCKER_PUBLISH_PORT_RETRIES
				) {
					return ensureLocalValidatorContainerWithFreshPorts({
						...params,
						attempt: params.attempt + 1,
						reconciliation: 'exact',
					});
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
): Effect.Effect<ReadonlyArray<ContainerPortPublish>, SuiPluginError, Scope.Scope> => {
	const pick = (containerPort: number, fallback: number): number => {
		if (!override) return fallback;
		const hit = override[containerPort];
		return typeof hit === 'number' ? hit : fallback;
	};
	if (override) {
		return Effect.succeed([
			portPublish(CONTAINER_RPC_PORT, pick(CONTAINER_RPC_PORT, DEFAULT_HOST_RPC_PORT)),
			portPublish(CONTAINER_FAUCET_PORT, pick(CONTAINER_FAUCET_PORT, DEFAULT_HOST_FAUCET_PORT)),
		]);
	}
	return Effect.gen(function* () {
		const rpc = yield* allocatePort(portBroker, 'rpc', DEFAULT_HOST_RPC_PORT, 'rpc');
		const faucet = yield* allocatePort(portBroker, 'http', DEFAULT_HOST_FAUCET_PORT, 'faucet');
		return [portPublish(CONTAINER_RPC_PORT, rpc), portPublish(CONTAINER_FAUCET_PORT, faucet)];
	});
};

export const resolvePublishedPortMapping = (
	requested: ReadonlyArray<ContainerPortPublish>,
	actual: ReadonlyArray<ContainerPortPublish> | undefined,
): ReadonlyArray<ContainerPortPublish> => [
	pickPublishedPort(requested, actual, CONTAINER_RPC_PORT, DEFAULT_HOST_RPC_PORT),
	pickPublishedPort(requested, actual, CONTAINER_FAUCET_PORT, DEFAULT_HOST_FAUCET_PORT),
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
	ports.some((port) => port.containerPort === CONTAINER_FAUCET_PORT);

const portPublish = (containerPort: number, hostPort: number): ContainerPortPublish => ({
	containerPort,
	hostPort,
	hostIp: DOCKER_PUBLISH_HOST,
});

const allocatePort = (
	portBroker: PortBroker,
	kind: PortKind,
	preferredPort: number,
	label: 'rpc' | 'faucet',
): Effect.Effect<number, SuiPluginError, Scope.Scope> =>
	portBroker
		.allocate({
			kind,
			preferredPort,
			probeHost: DOCKER_PUBLISH_HOST,
		})
		.pipe(
			Effect.map((allocated) => allocated.port),
			Effect.mapError((cause) =>
				suiPluginError(
					'port-allocate',
					`sui local mode: failed to allocate ${label} host port ` +
						`(preferred ${preferredPort}): ${cause.detail}`,
					cause,
				),
			),
		);

// ---------------------------------------------------------------------------
// Ready-probe coordination
// ---------------------------------------------------------------------------

/** Coordinated readiness gate. Both RPC + faucet must respond within
 *  the outer deadline; each probe has its own per-fetch deadline so a
 *  wedged endpoint surfaces by name. */
const waitForReady = (
	faucetUrl: string,
	sdkClient: SuiGrpcClient,
	readyTimeout: Duration.Duration,
): Effect.Effect<void, SuiPluginError> =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<ReadonlySet<'rpc' | 'faucet'>>(new Set());
		const markSeen = (k: 'rpc' | 'faucet') => Ref.update(seen, (s) => new Set([...s, k]));

		const rpcProbe: Effect.Effect<void, Error> = Effect.tryPromise({
			try: () => sdkClient.core.getChainIdentifier(),
			catch: (cause) => new Error(`rpc: ${stringifyCause(cause)}`),
		}).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(PROBE_FETCH_TIMEOUT_MS),
				orElse: () => Effect.fail(new Error('rpc: probe fetch timed out')),
			}),
			Effect.asVoid,
			Effect.tap(() => markSeen('rpc')),
			Effect.withSpan('devstack.plugin.sui.local.probe.rpc'),
		);

		// Faucet socket-level liveness — `GET /` returns "OK" as soon as
		// the HTTP server is bound. We do NOT POST `/v2/gas` here; that's
		// the funds-ready probe, which is paid for lazily on first call.
		const faucetProbe: Effect.Effect<void, Error> = probeFetch(faucetUrl, { method: 'GET' }).pipe(
			Effect.flatMap(
				(res): Effect.Effect<void, Error> =>
					res.status >= 500 ? Effect.fail(new Error(`faucet: ${res.status}`)) : Effect.void,
			),
			Effect.tap(() => markSeen('faucet')),
			Effect.withSpan('devstack.plugin.sui.local.probe.faucet'),
		);

		const combined = Effect.all([rpcProbe, faucetProbe], { concurrency: 'unbounded' }).pipe(
			Effect.asVoid,
			Effect.retry(Schedule.spaced(Duration.seconds(1))),
		);
		yield* combined.pipe(
			Effect.timeoutOrElse({
				duration: readyTimeout,
				orElse: () =>
					Effect.gen(function* () {
						const seenSet = yield* Ref.get(seen);
						const phase = !seenSet.has('rpc')
							? 'rpc-probe'
							: !seenSet.has('faucet')
								? 'faucet-probe'
								: 'rpc-probe';
						return yield* Effect.fail(
							suiPluginError(
								phase,
								`sui local mode: ready probes did not succeed within ${Duration.toMillis(readyTimeout)}ms. ` +
									`Last-seen probes=${JSON.stringify([...seenSet])}. ` +
									`Check that the validator container is healthy (\`docker logs\`).`,
							),
						);
					}),
			}),
			Effect.mapError(
				(cause): SuiPluginError =>
					cause && typeof cause === 'object' && '_tag' in cause && cause._tag === 'SuiPluginError'
						? (cause as SuiPluginError)
						: suiPluginError(
								'rpc-probe',
								`sui local mode: ready probe iteration failed: ${stringifyCause(cause)}`,
								cause,
							),
			),
		);
	}).pipe(Effect.withSpan('devstack.plugin.sui.local.waitForReady'));

/** Bounded `fetch` with `AbortSignal.timeout`. We avoid the global
 *  `signal` argument shape because Effect's `tryPromise` already
 *  injects its own. */
const probeFetch = (url: string, init: RequestInit): Effect.Effect<Response, Error> =>
	Effect.tryPromise({
		try: (signal) => {
			const combined = anySignal([signal, AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS)]);
			return fetch(url, { ...init, signal: combined });
		},
		catch: (cause) => new Error(`fetch: ${stringifyCause(cause)}`),
	});

const anySignal = (signals: ReadonlyArray<AbortSignal>): AbortSignal => {
	const ctrl = new AbortController();
	const onAbort = (s: AbortSignal) => () => ctrl.abort(s.reason);
	for (const s of signals) {
		if (s.aborted) {
			ctrl.abort(s.reason);
			return ctrl.signal;
		}
		s.addEventListener('abort', onAbort(s), { once: true });
	}
	return ctrl.signal;
};

// Chain-id fetch + waitForTransactionsReady builders live in
// `shared-boot.ts` — see imports at the top of this file.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
