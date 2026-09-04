// Sui plugin — fork mode.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import type { StackPaths } from '../../../substrate/runtime/paths.ts';
import type { AllocatedPort, PortBroker } from '../../../substrate/runtime/port-broker/index.ts';
import { ProbeTimeoutError, waitForProbe } from '../../../substrate/runtime/probes.ts';
import { formatUnknownError } from '../../../substrate/runtime/format-unknown-error.ts';
import { setCurrentPluginPhase } from '../../../substrate/runtime/current-plugin.ts';
import { renderUrl, routedHostname } from '../../../substrate/runtime/routed-url.ts';
import { extractExecuteDigest } from '../exec/index.ts';
import { resolveAutoTickIntervalMs, runAutoTickClock } from '../auto-tick.ts';
import {
	suiConfigError,
	suiPluginError,
	type SuiConfigError,
	type SuiPluginError,
} from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import { SUI_RPC_ENDPOINT_NAME, SUI_RPC_ENTRYPOINT_PORT } from '../routable.ts';
import { SuiLogAttr } from '../log-attrs.ts';
import { acquireForkDataDirHolder, wrapWithForkGuard } from '../fork-orchestration.ts';
import {
	FORK_IMPERSONATION_GAS_BUDGET,
	verifyForkImpersonationSender,
} from '../fork-transaction.ts';
import {
	configuredSuiToolsRef,
	DEFAULT_SUI_CLI_VERSION,
	suiCliImageBuildContext,
	suiToolsImage,
} from '../move/index.ts';
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

/** Env var that supplies a COMPLETE prebuilt `sui-fork` image (devstack
 *  entrypoint included) to pull for a single run. When set,
 *  `resolveForkImage` tries it and falls back to a source build on miss.
 *  Prefer `DEVSTACK_SUI_TOOLS_REF` (see `SUI_TOOLS_REF_ENV_VAR`), which
 *  needs no custom image: it layers the entrypoint onto a stock
 *  `mysten/sui-tools` build that ships `sui-fork`. */
export const FORK_IMAGE_ENV_VAR = 'DEVSTACK_SUI_FORK_IMAGE';

const prebuiltForkImageRef = (): string | undefined => {
	const fromEnv = process.env[FORK_IMAGE_ENV_VAR]?.trim();
	return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
};

/** Fork entrypoint inside the shared sui image (see images/sui/Dockerfile).
 *  The image's default ENTRYPOINT boots a localnet, so fork containers
 *  built on it pass this as the `--entrypoint` override. */
export const FORK_ENTRYPOINT = '/usr/local/bin/devstack-sui-fork-entrypoint.sh';

/** `RUST_LOG` for the fork container. Mirrors the source-build image's
 *  baked-in ENV so the shared sui image (which only sets `sui=info`)
 *  narrates `sui_fork` at the same level. */
export const FORK_RUST_LOG = 'info,sui_fork=info,sui=info';

export const DEFAULT_FORK_HOST_RPC_PORT = 51002;
export const FORK_VALIDATOR_STOP_GRACE_SECONDS = 30;

/** Default impersonation "whale" per upstream — a large-reserve address
 *  known to hold a big single SUI coin in the upstream's state, used as
 *  the fork faucet funding source when `faucet.whale` is omitted. `null`
 *  means no default is known (the faucet then requires an explicit
 *  `faucet.whale`). Validated at boot via `selectSufficientForkCoin`. */
export const FORK_DEFAULT_WHALE: Record<'mainnet' | 'testnet' | 'devnet', string | null> = {
	// Long-lived validator addresses each holding a large single SUI coin
	// (validated 2026-05-28). `selectSufficientForkCoin` re-queries the address
	// at the fork checkpoint at runtime, so a rotated coin self-heals; a
	// drained/retired address degrades gracefully — boot validation warns and
	// disables the default faucet. Override any of these with `faucet.whale`.
	mainnet: '0xbc7e7537564bd939b62e5b24477ac00ba8cef33ccec72d63090a080a1253b725', // ~273k SUI
	testnet: '0xc397477d8b445e6295bc34e593b9a95d5d233cec1a8fe3740d0ab86012a460f6', // ~127k SUI
	// devnet resets periodically; this genesis validator may go stale after a
	// reset, at which point the default faucet disables itself until a
	// `faucet.whale` is supplied.
	devnet: '0x4296747d0bd91c41b668702bdca0bf769a0e32db66982d986101e7975db55cbe', // ~30M SUI
};

/** The common per-account fund the fork faucet must be able to cover. Mirrors
 *  the account plugin's `DEFAULT_EPHEMERAL_FUND_MIST` (1 SUI) — kept local
 *  because account → sui already, so importing it here would cycle; a test
 *  pins the two together. */
export const FORK_FAUCET_DEFAULT_FUND_MIST = 1_000_000_000n;

/** Floor a single whale SUI coin must clear at boot to enable the fork faucet:
 *  a default ephemeral fund (1 SUI) plus the impersonation gas budget. Set to
 *  match the per-request requirement for the default fund so a whale that
 *  passes boot can actually satisfy the first auto-fund. */
export const FORK_FAUCET_WHALE_MIN_COIN_MIST =
	FORK_FAUCET_DEFAULT_FUND_MIST + FORK_IMPERSONATION_GAS_BUDGET;

/** Default per-request funding cap (MIST) — 1000 SUI. */
export const DEFAULT_FORK_FAUCET_PER_REQUEST_CAP_MIST = 1_000_000_000_000n;

/** Resolved fork faucet funding source. */
export interface ResolvedForkWhale {
	readonly whale: string;
	readonly perRequestCapMist: bigint;
	/** `true` when the user set `faucet.whale` explicitly — a validation
	 *  failure then hard-fails boot; a default whale only warns + disables
	 *  the faucet so the fork still boots. */
	readonly explicit: boolean;
}

/** Resolve the fork faucet whale from options + per-upstream defaults,
 *  or `null` when the faucet is disabled / no whale is known. */
export const resolveForkWhale = (opts: SuiForkOptions): ResolvedForkWhale | null => {
	if (opts.faucet?.enabled === false) {
		return null;
	}
	const perRequestCapMist =
		opts.faucet?.perRequestCapMist ?? DEFAULT_FORK_FAUCET_PER_REQUEST_CAP_MIST;
	const explicit = opts.faucet?.whale?.trim();
	if (explicit !== undefined && explicit.length > 0) {
		return { whale: normalizeSuiAddress(explicit), perRequestCapMist, explicit: true };
	}
	const fallback = FORK_DEFAULT_WHALE[opts.upstream];
	return fallback === null
		? null
		: { whale: normalizeSuiAddress(fallback), perRequestCapMist, explicit: false };
};

/** Inject the resolved faucet whale into the fork seed so its coins exist
 *  in fork state. MUST run before the data-dir key / container config
 *  hash are computed (both fold the seed) so enabling the faucet doesn't
 *  silently reuse a whale-less fork data dir. */
export const withForkFaucetSeed = (opts: SuiForkOptions): SuiForkOptions => {
	const resolved = resolveForkWhale(opts);
	if (resolved === null) {
		return opts;
	}
	return {
		...opts,
		seed: {
			...opts.seed,
			addresses: [...(opts.seed?.addresses ?? []), resolved.whale],
		},
	};
};

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
): Effect.Effect<ForkModeBootResult, SuiPluginError | SuiConfigError, Scope.Scope> =>
	Effect.gen(function* () {
		const autoTickIntervalMs = yield* resolveAutoTickIntervalMs(opts.autoTick);
		// Fold the faucet whale into the seed BEFORE the data-dir key /
		// container config hash are derived, so enabling the faucet keys a
		// distinct fork state rather than reusing a whale-less data dir.
		yield* validateForkImageOptions(opts);
		const seededOpts = withForkFaucetSeed(opts);
		const { ref: image, entrypoint } = yield* resolveForkImage(runtime, identity, opts);
		const dataDir = yield* ensureForkDataDir(paths, seededOpts);

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
			entrypoint,
			labels,
			containerName,
			dataDir,
			opts: seededOpts,
		});

		const published = pickPublishedPort(ports, handle.ports);
		const directRpcUrl = `http://127.0.0.1:${published.hostPort}`;
		const rpcUrl = yield* routedSuiRpcUrl(identity);
		const sdkClient = new SuiGrpcClient({ baseUrl: directRpcUrl, network: opts.upstream });
		const readyTimeout = opts.readyTimeout ?? DEFAULT_FORK_READY_TIMEOUT;

		const status = yield* waitForForkReady(sdkClient, readyTimeout).pipe(
			Effect.annotateLogs({ [SuiLogAttr.container]: handle.name }),
		);
		const chainId = yield* sharedFetchChainId(sdkClient);

		const fork = makeForkAdminSurface(sdkClient);
		const assembled = yield* assembleSuiClient({
			sdkClient,
			chainId,
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
				chainId,
				rpc: rpcUrl,
				source: 'default',
				checkpoint: status.forkedAtCheckpoint,
				forkUpstream: opts.upstream,
			}),
			client,
			autoTickIntervalMs,
		};
	});

/** Build context for the from-source `sui-fork` image. */
export const suiForkImageBuildContext = (rev = DEFAULT_SUI_FORK_REV) => ({
	// `fileURLToPath` normalises the URL → host-path conversion across
	// platforms (Windows `file:///C:/...` → `C:\...`). Reading
	// `.pathname` directly leaves the leading `/` on Windows drive paths.
	contextPath: fileURLToPath(new URL('../../../../images/', import.meta.url)),
	dockerfile: 'sui-fork/Dockerfile',
	buildArgs: { SUI_FORK_REV: rev, SUI_CLI_VERSION: DEFAULT_SUI_CLI_VERSION },
});

/** Where fork mode gets its image. Pure — derived from options + env — so
 *  it is unit-testable and can be folded into the data-dir key and the
 *  container config hash. Precedence: explicit `image` config, then a
 *  sui-tools ref (`suiToolsRef` option, then `DEVSTACK_SUI_TOOLS_REF`),
 *  then the complete-image env var, then the source build. */
export type ForkImagePlan =
	| { readonly kind: 'pull'; readonly ref: string }
	| {
			readonly kind: 'custom-build';
			readonly context: string;
			readonly dockerfile: string;
			readonly rev: string;
			readonly suiToolsRef: string | undefined;
	  }
	| { readonly kind: 'sui-tools'; readonly ref: string }
	| { readonly kind: 'prebuilt-or-source'; readonly ref: string; readonly rev: string }
	| { readonly kind: 'source'; readonly rev: string };

export const planForkImage = (opts: SuiForkOptions): ForkImagePlan => {
	const rev = opts.version ?? DEFAULT_SUI_FORK_REV;
	if (opts.image && 'pull' in opts.image) {
		return { kind: 'pull', ref: opts.image.pull };
	}
	const suiToolsRef = configuredSuiToolsRef(opts.suiToolsRef);
	if (opts.image && 'build' in opts.image) {
		return {
			kind: 'custom-build',
			context: opts.image.build.context,
			dockerfile: opts.image.build.dockerfile ?? 'Dockerfile',
			rev,
			suiToolsRef,
		};
	}
	if (suiToolsRef !== undefined) {
		return { kind: 'sui-tools', ref: suiToolsRef };
	}
	const prebuilt = prebuiltForkImageRef();
	if (prebuilt !== undefined) {
		return { kind: 'prebuilt-or-source', ref: prebuilt, rev };
	}
	return { kind: 'source', rev };
};

/** Identity of the `sui-fork` binary a fork boots with — folded into the
 *  data-dir key and container config hash so switching binaries never
 *  reuses state written by a different one. Every non-sui-tools plan keeps
 *  the bare source revision it always had, so existing data dirs stay
 *  addressable. */
export const forkBinaryVersion = (opts: SuiForkOptions): string => {
	const plan = planForkImage(opts);
	return plan.kind === 'sui-tools'
		? `sui-tools:${plan.ref}`
		: (opts.version ?? DEFAULT_SUI_FORK_REV);
};

/** Reject option pairs that each name a different binary to run. Only
 *  config-vs-config conflicts fail: the env vars are per-run overrides
 *  and are allowed to displace `version`, matching how
 *  `DEVSTACK_SUI_FORK_IMAGE` has always behaved. */
export const validateForkImageOptions = (
	opts: SuiForkOptions,
): Effect.Effect<void, SuiConfigError> => {
	if (opts.suiToolsRef === undefined) {
		return Effect.void;
	}
	if (opts.image && 'pull' in opts.image) {
		return Effect.fail(
			suiConfigError({
				field: 'suiToolsRef',
				message:
					'sui fork mode: `suiToolsRef` and `image.pull` both name the image to run; keep one.',
				hint: '`suiToolsRef` layers the devstack entrypoint onto a mysten/sui-tools build; `image.pull` expects a complete image that already has it.',
			}),
		);
	}
	if (opts.version !== undefined) {
		return Effect.fail(
			suiConfigError({
				field: 'suiToolsRef',
				message:
					'sui fork mode: `version` pins a from-source sui-fork revision, which `suiToolsRef` replaces with a prebuilt binary; keep one.',
				hint: 'Drop `version` to run the sui-fork shipped in that sui-tools build, or drop `suiToolsRef` to compile the pinned revision.',
			}),
		);
	}
	return Effect.void;
};

/** A resolved fork image plus the container entrypoint it needs. */
export interface ResolvedForkImage {
	readonly ref: ImageRef;
	/** `--entrypoint` override. Set when the image is the shared sui image,
	 *  whose default ENTRYPOINT boots a localnet rather than `sui-fork`. */
	readonly entrypoint: string | undefined;
}

/** Pull a prebuilt fork image, narrating progress on the supervisor row.
 *  Fails with a `SuiPluginError` if the runtime can't pull or the pull errors. */
const pullForkImage = (
	runtime: ContainerRuntime,
	pullRef: string,
): Effect.Effect<ImageRef, SuiPluginError> =>
	Effect.gen(function* () {
		if (runtime.pullImage === undefined) {
			return yield* Effect.fail(
				suiPluginError(
					'image-build',
					`sui fork mode cannot pull image '${pullRef}' because the configured container runtime does not expose image pulls.`,
				),
			);
		}
		yield* setCurrentPluginPhase(`pulling sui-fork image ${pullRef}…`);
		return yield* runtime.pullImage(pullRef).pipe(
			Effect.mapError((cause) =>
				suiPluginError(
					'image-build',
					`sui fork mode failed to pull image '${pullRef}': ${cause.reason}: ${cause.detail}`,
					cause,
				),
			),
			Effect.ensuring(setCurrentPluginPhase(null)),
		);
	});

const SOURCE_BUILD_PHASE =
	'building sui-fork image — first run compiles sui-fork from source (~10+ min); cached after';

/** Build a fork image via `ensureImage`, narrating `phase` on the
 *  supervisor row so a long build doesn't look hung. */
const buildForkImage = (
	runtime: ContainerRuntime,
	buildCtx: Parameters<ContainerRuntime['ensureImage']>[0],
	phase: string,
): Effect.Effect<ImageRef, SuiPluginError> =>
	Effect.gen(function* () {
		yield* setCurrentPluginPhase(phase);
		return yield* runtime.ensureImage(buildCtx).pipe(
			Effect.mapError((cause) =>
				suiPluginError(
					'image-build',
					`sui fork image build failed: ${cause.reason}: ${cause.detail}`,
					cause,
				),
			),
			Effect.ensuring(setCurrentPluginPhase(null)),
		);
	});

export const resolveForkImage = (
	runtime: ContainerRuntime,
	identity: Identity,
	opts: SuiForkOptions,
): Effect.Effect<ResolvedForkImage, SuiPluginError> =>
	Effect.gen(function* () {
		const owner = {
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'validator',
		} as const;
		const plan = planForkImage(opts);
		switch (plan.kind) {
			case 'pull':
				return { ref: yield* pullForkImage(runtime, plan.ref), entrypoint: undefined };
			case 'custom-build':
				return {
					ref: yield* buildForkImage(
						runtime,
						{
							contextPath: plan.context,
							dockerfile: plan.dockerfile,
							buildArgs: {
								SUI_FORK_REV: plan.rev,
								SUI_CLI_VERSION: DEFAULT_SUI_CLI_VERSION,
								...(plan.suiToolsRef === undefined
									? {}
									: { SUI_TOOLS_IMAGE: suiToolsImage(plan.suiToolsRef) }),
							},
							owner,
						},
						'building sui-fork image from the configured Dockerfile…',
					),
					entrypoint: undefined,
				};
			case 'sui-tools':
				// Same image local mode runs; only the entrypoint differs. Seconds,
				// not minutes: one apt layer on top of a pulled sui-tools.
				return {
					ref: yield* buildForkImage(
						runtime,
						{ ...suiCliImageBuildContext(plan.ref), owner },
						`layering devstack entrypoints onto ${suiToolsImage(plan.ref)}…`,
					),
					entrypoint: FORK_ENTRYPOINT,
				};
			case 'prebuilt-or-source': {
				const ref = yield* pullForkImage(runtime, plan.ref).pipe(
					Effect.catchTag('SuiPluginError', (cause) =>
						Effect.gen(function* () {
							yield* Effect.logWarning(
								`sui fork mode: prebuilt image '${plan.ref}' unavailable (${cause.message}); building from source.`,
							);
							return yield* buildForkImage(
								runtime,
								{ ...suiForkImageBuildContext(plan.rev), owner },
								SOURCE_BUILD_PHASE,
							);
						}),
					),
				);
				return { ref, entrypoint: undefined };
			}
			case 'source':
				return {
					ref: yield* buildForkImage(
						runtime,
						{ ...suiForkImageBuildContext(plan.rev), owner },
						SOURCE_BUILD_PHASE,
					),
					entrypoint: undefined,
				};
		}
	});

interface ForkContainerResult {
	readonly handle: ContainerHandle;
	readonly ports: ReadonlyArray<ContainerPortPublish>;
}

const ensureForkContainer = (params: {
	readonly runtime: ContainerRuntime;
	readonly portBroker: PortBroker;
	readonly image: ImageRef;
	readonly entrypoint: string | undefined;
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
				entrypoint: params.entrypoint,
				env: { RUST_LOG: FORK_RUST_LOG },
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
				version: forkBinaryVersion(opts),
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
				version: forkBinaryVersion(opts),
				seed: normalizeForkSeed(opts),
			}),
		)
		.digest('hex')
		.slice(0, 16);

/** Bring the data dir into being and claim it against concurrent
 *  stacks via the holder protocol. The holder claim is scope-bound —
 *  it heartbeats for the stack's lifetime and releases on teardown. */
const ensureForkDataDir = (
	paths: StackPaths,
	opts: SuiForkOptions,
): Effect.Effect<string, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const dataDir = resolve(join(paths.stackRoot, 'sui-fork', forkDataDirKey(opts)));
		yield* Effect.tryPromise({
			try: () => mkdir(dataDir, { recursive: true, mode: 0o700 }),
			catch: (cause) =>
				suiPluginError(
					'fork-data-dir',
					`sui fork mode: failed to create data directory ${dataDir}: ${formatUnknownError(cause)}`,
					cause,
				),
		});
		yield* acquireForkDataDirHolder(paths.stackLockFile, dataDir);
		return dataDir;
	});

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
							`sui fork mode: ForkingService.GetStatus did not become ready within ${readyTimeoutMs}ms. ` +
								`Inspect the sui-fork container logs (\`docker logs\`); if the image is still ` +
								`building or the upstream checkpoint is large, raise the \`readyTimeout\` option.`,
							cause.lastError ?? cause.lastNotReady ?? cause,
						)
					: suiPluginError(
							'fork-status-probe',
							`sui fork mode: ForkingService.GetStatus probe failed: ${formatUnknownError(cause)}`,
							cause,
						),
			),
		);
		return yield* readForkStatus(sdkClient);
	});

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
					`sui fork mode: advanceClock(${intervalMs}) failed: ${formatUnknownError(cause)}`,
					cause,
				),
		}).pipe(Effect.asVoid),
	advanceCheckpoint: Effect.tryPromise({
		try: () => sdkClient.forkingService.advanceCheckpoint({}).response,
		catch: (cause) =>
			suiPluginError(
				'fork-advance-checkpoint',
				`sui fork mode: advanceCheckpoint failed: ${formatUnknownError(cause)}`,
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
						`sui fork mode: impersonate(${sender}) failed: ${formatUnknownError(cause)}`,
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
				`sui fork mode: GetStatus failed: ${formatUnknownError(cause)}`,
				cause,
			),
	});

const routedSuiRpcUrl = (identity: Identity): Effect.Effect<string, SuiPluginError> =>
	routedHostname(identity, SUI_RPC_ENDPOINT_NAME).pipe(
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

const isFailedTransaction = (raw: unknown): boolean =>
	(raw as { readonly $kind?: string }).$kind === 'FailedTransaction';
