// Shared E2E boot implementation — parameterized by a config module
// or inline stack plus identity strings. The substrate Layer wiring
// and projection-read flow are IDENTICAL across all rewrite e2e boot
// suites; the only things that vary are the stack under test and the
// app/stack identity strings the substrate scopes the runtime root by.
//
// Each test file calls `runBoot(opts)` with its parameters; the
// function NEVER throws on a plugin-level failure (so the test can
// surface a clean assertion) — it captures per-plugin failures in
// `failures: [...]`. A throw from this function means the substrate
// Layer itself failed to compose, which is a different (and worse)
// class of failure.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cause, Context, Effect, FileSystem, Layer, Logger, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { readStackEngine, type Stack } from '../../src/api/define-devstack.ts';
import { appName, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import {
	IdentityContext,
	RuntimeRoot,
	StackPathsService,
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
} from '../../src/substrate/runtime/paths.ts';
import { CacheService, layerCache } from '../../src/substrate/runtime/cache/index.ts';
import {
	StrategyRegistryService,
	layerStrategyRegistry,
} from '../../src/substrate/runtime/strategy-registry/index.ts';
import type { EntrypointDecl } from '../../src/contracts/routable.ts';
import { layerEntrypointRegistry } from '../../src/orchestrators/router/entrypoints.ts';
import { BUILT_IN_ENTRYPOINTS } from '../../src/plugins/router-entrypoints.ts';
import type { ResolvedRoute } from '../../src/orchestrators/router/file-provider.ts';
import {
	RouterService,
	UpstreamResolverService,
	layerDockerUpstreamResolver,
	layerRouterConfigLiteral,
	layerRouterService,
} from '../../src/orchestrators/router/service.ts';
import {
	layerTraefikContainerOpsDocker,
	layerTraefikContainerOpsStub,
	TraefikContainerOpsService,
} from '../../src/orchestrators/router/traefik-container.ts';
import { ROUTER_CONTAINER_NAME_PREFIX } from '../../src/orchestrators/router/sentinels.ts';
import {
	MoveCodegenService,
	MoveSummaryRunnerService,
	stubMoveCodegen,
	stubMoveSummaryRunner,
} from '../../src/orchestrators/codegen/bindings.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../src/orchestrators/codegen/paths.ts';
import {
	CodegenOrchestratorService,
	layerCodegenOrchestrator,
} from '../../src/orchestrators/codegen/service.ts';
import {
	DEPLOYMENT_FILENAME,
	writeDeployment,
	type DevstackDeployment,
} from '../../src/orchestrators/codegen/deployment.ts';
import { CoinRegistryService, layerCoinRegistry } from '../../src/plugins/coin/registry.ts';
import {
	PackageRegistryService,
	layerPackageRegistry,
} from '../../src/plugins/package/registry.ts';
import {
	PortBrokerService,
	layerPortBroker,
} from '../../src/substrate/runtime/port-broker/index.ts';
import {
	PostAcquireTasksService,
	layerPostAcquireTasks,
} from '../../src/substrate/runtime/post-acquire-tasks.ts';
import {
	LeaseBrokerService,
	layerLeaseBroker,
} from '../../src/substrate/runtime/lease-broker/index.ts';
import {
	makeProjectionRef,
	supervise,
	type SupervisedStack,
} from '../../src/substrate/runtime/index.ts';
import { readResolvedSync } from '../../src/substrate/runtime/lifecycle/index.ts';
import {
	buildProductionContributionDispatcher,
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
	layerManifestEndpointRegistry,
	productionRouterProfile,
} from '../../src/orchestrators/boot.ts';
import {
	SnapshotOrchestratorService,
	layerSnapshotOrchestrator,
	snapshotGraphInputFromIdentity,
	type SnapshotCatalogEntry,
	type SnapshotMetadata,
} from '../../src/orchestrators/snapshot/index.ts';
import { computeStackGraphInputIdentity } from '../../src/substrate/runtime/lifecycle/graph-input-id.ts';
import {
	ContainerRuntimeService,
	DockerSpawner,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
	layerDockerHostDefault,
} from '../../src/runtime/docker/index.ts';
import { dockerSpawnSync } from './docker-prune.ts';

/** Context surfaced to `withinScope` callbacks. Carries every handle a
 *  test needs to assert against a still-running stack — resolved
 *  values, the docker `ContainerRuntime`, the substrate strategy
 *  registry (for faucet / chain-probe lookups), snapshot smoke hooks,
 *  and the test identity.
 */
export interface BootSnapshotFacade {
	readonly captureMetadata: (id: string) => Effect.Effect<SnapshotMetadata, unknown, never>;
	readonly capture: (id: string) => Effect.Effect<SnapshotMetadata, unknown, never>;
	readonly restore: (id: string) => Effect.Effect<SnapshotMetadata, unknown, never>;
	readonly list: Effect.Effect<ReadonlyArray<SnapshotCatalogEntry>, unknown, never>;
}

export interface BootScopeContext {
	readonly resolvedValues: ReadonlyMap<string, unknown>;
	readonly containerRuntime: import('../../src/contracts/container-runtime.ts').ContainerRuntime;
	readonly strategyRegistry: import('../../src/contracts/strategy-contributor.ts').StrategyRegistry;
	readonly identity: Identity;
	readonly snapshot: BootSnapshotFacade;
	/** Submit a supervisor command (e.g. `selective-restart.requested`) and
	 *  await its completion — lets a probe drive a live lifecycle transition
	 *  (the watcher's selective restart) without the real fs watcher. */
	readonly runCommand: (
		command: import('../../src/substrate/events.ts').EngineCommand,
	) => Effect.Effect<void, unknown>;
	/** Re-read a plugin's CURRENT resolved value by ready key — picks up the
	 *  fresh value after a restart (e.g. a package's new id post-republish). */
	readonly readResolved: (key: string) => unknown;
}

interface BootStackConfig {
	readonly members: SupervisedStack['members'];
	readonly options: SupervisedStack['options'];
}

type BootSource =
	| {
			readonly configPath: string;
			readonly stack?: never;
	  }
	| {
			readonly stack: BootStackConfig;
			readonly configPath?: never;
	  };

export type BootOptions = BootSource & {
	readonly appName: string;
	readonly stackName: string;
	readonly chainId?: string;
	/** Opt-in: reuse a runtime root across invocations to simulate a
	 *  process restart of the same stack. Omitted means isolated temp root. */
	readonly runtimeRoot?: string;
	/** Opt-in: reuse router profile state across invocations. Useful with
	 *  `runtimeRoot` for warm-restart e2e coverage. */
	readonly routerStateRoot?: string;
	/** Opt-in: limit router entrypoints for tests that need the real router
	 *  but not every built-in host port. */
	readonly routerEntrypoints?: ReadonlyArray<EntrypointDecl>;
	/** Opt-in: project `{digest, objectChanges}` from a specific
	 *  ready key's resolved value. Used by the connect-four test to assert
	 *  the openLobby action produced a real digest + created object. */
	readonly digestFromKey?: string;
	/** Opt-in: an Effect that runs INSIDE the boot scope (containers
	 *  still up, resolved values fresh) just before the scope unwinds.
	 *  Use for assertions that require a live stack — exec into a
	 *  container, query a running daemon, probe a TCP port. The Effect
	 *  MUST fully consume its requirements; the boot driver provides
	 *  no extra services beyond the callback context. */
	readonly withinScope?: (ctx: BootScopeContext) => Effect.Effect<void, unknown, never>;
	/** Seam-only opt-in: run the stub-backed codegen cycle after all
	 *  plugins reach ready. Output is always rooted under this boot's
	 *  temp runtime dir, never under examples/src. */
	readonly runCodegen?: boolean;
	/** Opt-in: wire the REAL Traefik container ops + docker upstream resolver
	 *  (exactly like `devstack up`) instead of the fake host-loopback resolver.
	 *  The fake resolver returns 127.0.0.1, which only reaches host-published
	 *  ports (fine for the sui RPC) — but NOT the container-to-container routed
	 *  endpoints like the Walrus storage-node HTTP API the SDK PUTs slivers to.
	 *  Heavier (boots a real Traefik); set it only when a test drives routed
	 *  container traffic. */
	readonly useRealRouter?: boolean;
};

export interface BootCodegenRun {
	/** Directory holding the written `deployment.json` (boot's only
	 *  codegen-adjacent output now — the committed tree is the stack-free
	 *  `devstack codegen` verb's job). */
	readonly outputDir: string;
	/** Absolute path to the written deployment file. */
	readonly deploymentFile: string;
	/** The assembled deployment (the live on-chain ids). */
	readonly deployment: DevstackDeployment;
}

export interface BootResult {
	readonly readyKeys: ReadonlyArray<string>;
	readonly failures: ReadonlyArray<{ readonly key: string; readonly cause: string }>;
	readonly topLevelErrorCount: number;
	readonly digestFromKey: string | null;
	readonly createdObjectCount: number | null;
	/** Every resolved plugin value, keyed by the supervisor's ordinal
	 *  ready key (e.g. `sui#0`, `account/alice#1`). Always populated;
	 *  tests project the shapes they need. */
	readonly resolvedValues: ReadonlyMap<string, unknown>;
	readonly runtimeRoot: string;
	readonly routerDispatchDir: string;
	readonly routerAppliedRoutes: ReadonlyArray<ResolvedRoute>;
	readonly codegenOutputDir: string;
	readonly codegenRun: BootCodegenRun | null;
}

interface ConfigModule {
	readonly default: Stack<SupervisedStack['members']>;
}

// DockerSpawner adapts platform-node's ChildProcessSpawner tag to
// the docker subsystem's local DockerSpawner tag (same shape; the
// indirection only lets tests inject a stub).
const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const removeDevstackRoutersForRealRouterE2e = (): void => {
	try {
		const listed = dockerSpawnSync(
			['ps', '-aq', '--filter', `name=${ROUTER_CONTAINER_NAME_PREFIX}`],
			{ timeout: 30_000 },
		);
		if (listed.status !== 0) return;
		const ids = listed.stdout.split(/\s+/).filter((id) => id !== '');
		if (ids.length === 0) return;
		dockerSpawnSync(['rm', '-f', ...ids], { timeout: 60_000 });
	} catch {
		// Best-effort: if cleanup fails, router boot reports the concrete
		// Docker error, including any port holder.
	}
};

export const runBoot = async (opts: BootOptions): Promise<BootResult> => {
	const identity: Identity = {
		app: appName(opts.appName),
		stack: stackName(opts.stackName),
		network: opts.chainId ?? 'localnet',
	};

	// One fresh tmpdir per call by default. Tests can pass a root to
	// exercise warm restarts against the same persisted state.
	const runtimeRoot = opts.runtimeRoot ?? mkdtempSync(join(tmpdir(), `e2e-boot-${opts.appName}-`));
	const routerProfile = productionRouterProfile({
		stateRoot: opts.routerStateRoot ?? mkdtempSync(join(tmpdir(), `e2e-router-${opts.appName}-`)),
		env: { DOCKER_CONTEXT: 'test-context', DOCKER_HOST: undefined },
	});
	const routerDispatchDir = routerProfile.dispatchDir;
	const codegenOutputDir = join(runtimeRoot, 'codegen');
	const routerEntrypoints = opts.routerEntrypoints ?? BUILT_IN_ENTRYPOINTS;

	const platformBase = Layer.mergeAll(
		layerIdentity(identity),
		layerRuntimeRoot(runtimeRoot),
		NodePath.layer,
		NodeFileSystem.layer,
		layerDockerHostDefault,
		layerDockerCycleInitial,
		layerStrategyRegistry,
	);

	const childProcessSpawnerWired = NodeChildProcessSpawner.layer.pipe(
		Layer.provideMerge(platformBase),
	);
	const withStackPaths = layerStackPaths.pipe(Layer.provideMerge(childProcessSpawnerWired));
	const withCache = layerCache.pipe(Layer.provideMerge(withStackPaths));
	const withCoinRegistry = layerCoinRegistry.pipe(Layer.provideMerge(withCache));
	const withPackageRegistry = layerPackageRegistry.pipe(Layer.provideMerge(withCoinRegistry));
	const withPortBroker = layerPortBroker.pipe(Layer.provideMerge(withPackageRegistry));
	const withLeaseBroker = layerLeaseBroker.pipe(Layer.provideMerge(withPortBroker));
	const withPostAcquireTasks = layerPostAcquireTasks.pipe(Layer.provideMerge(withLeaseBroker));
	const withSpawnerAdapter = layerDockerSpawnerFromNode.pipe(Layer.provideMerge(withLeaseBroker));
	const withContainerRuntime = layerContainerRuntimeDocker.pipe(
		Layer.provideMerge(withSpawnerAdapter),
	);
	const withSnapshotOrchestrator = layerSnapshotOrchestrator.pipe(
		Layer.provideMerge(withContainerRuntime),
	);
	const fakeRouterUpstreams = Layer.succeed(UpstreamResolverService)({
		resolveContainer: (target) => Effect.succeed({ host: '127.0.0.1', port: target.containerPort }),
		resolveHostLoopback: (target) => Effect.succeed({ host: '127.0.0.1', port: target.port }),
	});
	const routerConfig = layerRouterConfigLiteral({
		disabled: false,
		profile: routerProfile,
		image: 'traefik:v3.5',
	});
	// `useRealRouter` wires the same real Traefik + docker upstream resolver as
	// `devstack up`, so container-to-container routed endpoints (e.g. the Walrus
	// storage-node API the SDK writes slivers to) actually route.
	// `withSpawnerAdapter` supplies the DockerHost + DockerSpawner they need.
	const withRouter = layerRouterService.pipe(
		Layer.provideMerge(
			opts.useRealRouter === true
				? Layer.mergeAll(
						layerEntrypointRegistry(routerEntrypoints),
						layerTraefikContainerOpsDocker,
						layerDockerUpstreamResolver(routerProfile),
						routerConfig,
					).pipe(Layer.provideMerge(withSpawnerAdapter))
				: Layer.mergeAll(
						platformBase,
						layerEntrypointRegistry(routerEntrypoints),
						layerTraefikContainerOpsStub,
						fakeRouterUpstreams,
						routerConfig,
					),
		),
	);
	const stubMoveLayers = Layer.mergeAll(
		Layer.succeed(MoveSummaryRunnerService)(
			stubMoveSummaryRunner((sourcePath) => ({
				packageName: sourcePath,
				sourcePath,
				summaryJson: {},
			})),
		),
		Layer.succeed(MoveCodegenService)(
			stubMoveCodegen((input) => [
				{
					relPath: `${input.packageName}/index.ts`,
					content: `export const ID = "${input.mvrPlaceholder}";\n`,
				},
			]),
		),
	);
	const withCodegenPaths = layerCodegenPaths.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				NodePath.layer,
				layerCodegenRoot({
					outputDir: codegenOutputDir,
					stackSubdir: null,
				}),
			),
		),
	);
	const withCodegen = Layer.mergeAll(layerCodegenOrchestrator, withCodegenPaths, stubMoveLayers);
	const substrateLayers = Layer.mergeAll(
		withSnapshotOrchestrator,
		withRouter,
		withCodegen,
		layerManifestEndpointRegistry,
		withPostAcquireTasks,
	);

	const loadStack = (): Effect.Effect<BootStackConfig, never> => {
		if (opts.stack !== undefined) return Effect.succeed(opts.stack);
		return Effect.tryPromise({
			try: () => import(opts.configPath) as Promise<ConfigModule>,
			catch: (e) => new Error(`failed to load config at ${opts.configPath}: ${String(e)}`),
		}).pipe(
			Effect.map((mod) => readStackEngine(mod.default)),
			Effect.orDie,
		);
	};

	const digestFromKey = opts.digestFromKey ?? '';

	const program = Effect.gen(function* () {
		const stack = yield* loadStack();

		const identityCtx = yield* IdentityContext;
		const runtimeRootResolved = yield* RuntimeRoot;
		const stackPaths = yield* StackPathsService;
		const cache = yield* CacheService;
		const registry = yield* StrategyRegistryService;
		const containerRuntime = yield* ContainerRuntimeService;
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		const packageRegistry = yield* PackageRegistryService;
		const coinRegistry = yield* CoinRegistryService;
		const portBroker = yield* PortBrokerService;
		const leaseBroker = yield* LeaseBrokerService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const router = yield* RouterService;
		const codegen = yield* CodegenOrchestratorService;
		const traefikOps = opts.useRealRouter === true ? yield* TraefikContainerOpsService : null;

		const pluginContext = Context.empty().pipe(
			Context.add(IdentityContext, identityCtx),
			Context.add(RuntimeRoot, runtimeRootResolved),
			Context.add(StackPathsService, stackPaths),
			Context.add(CacheService, cache),
			Context.add(StrategyRegistryService, registry),
			Context.add(ContainerRuntimeService, containerRuntime),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PortBrokerService, portBroker),
			Context.add(LeaseBrokerService, leaseBroker),
			Context.add(PostAcquireTasksService, postAcquireTasks),
		) as Context.Context<never>;

		const state = yield* makeProjectionRef();
		const contributionDispatcher = yield* buildProductionContributionDispatcher();
		const provideFileSystem = <A, E>(
			effect: Effect.Effect<A, E, FileSystem.FileSystem>,
		): Effect.Effect<A, E, never> => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));
		// Live-supervisor RESUME for the snapshot bounce. Capture/restore run
		// the bounce (gather → stop → commit/load → retag → hard-rm); the resume
		// (recreate + wait-write-ready) is a stack restart whose converge re-runs
		// each plugin's acquire — including walrus's write-ready ready-gate. The
		// handle is set after `supervise()` below; the facade reads it lazily so
		// the captured stack comes back write-ready before the probe writes S2.
		let resumeStack: Effect.Effect<void, unknown, never> = Effect.void;
		// Refresh the resolved-value map handed to `withinScope` AFTER a
		// capture/restore resume. The STEP-2 bounce hard-rms + recreates every
		// managed container (graceful-stop flush — NEVER `docker pause`, which
		// walrus storage nodes can't survive), so the recreate yields a NEW
		// resolved value per plugin (e.g. a fresh `SuiGrpcClient` whose channel
		// targets the recreated validator). A consumer that kept the PRE-bounce
		// resolved value would call a dead gRPC channel and see `fetch failed`
		// on its first post-resume RPC. The resume re-acquire repopulates the
		// registry's live resolved map, so re-reading it here and mutating the
		// shared `withinScope` map IN PLACE lets probes rebuild against the
		// fresh, write-ready stack. Assigned once `supervise()` + the map exist.
		let refreshResolvedValues: Effect.Effect<void> = Effect.void;
		const computeGraphInput = (devstackVersion = '0.0.0-e2e') =>
			computeStackGraphInputIdentity({
				stack: { members: stack.members, options: stack.options },
				devstackVersion,
			}).pipe(Effect.map(snapshotGraphInputFromIdentity));
		const snapshotFacade: BootSnapshotFacade = {
			capture: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					const graphInput = yield* computeGraphInput();
					const meta = yield* provideFileSystem(
						snapshot.capture({ id, graphInput, resume: Effect.orDie(resumeStack) }),
					);
					yield* refreshResolvedValues;
					return meta;
				}),
			captureMetadata: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					const graphInput = yield* computeGraphInput();
					const meta = yield* provideFileSystem(
						snapshot.capture({ id, graphInput, resume: Effect.orDie(resumeStack) }),
					);
					yield* refreshResolvedValues;
					return meta;
				}),
			restore: (id) =>
				Effect.gen(function* () {
					const meta = yield* provideFileSystem(
						snapshot.restore({ id, resume: Effect.orDie(resumeStack) }),
					);
					yield* refreshResolvedValues;
					return meta;
				}),
			list: provideFileSystem(snapshot.list),
		};

		// supervise() + per-plugin awaitReady inside a Scope so finalizers
		// run before we read the projection snapshot.
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				// Router traffic itself is not exercised here: the e2e
				// harness injects a stub Traefik container layer plus a
				// fake upstream resolver, while using the same sink delivery
				// path as production. Production boots the router via the same
				// `router.boot()` call (see boot.ts dispatcher).
				if (traefikOps !== null) {
					yield* Effect.sync(removeDevstackRoutersForRealRouterE2e);
					yield* traefikOps.forceRemove(routerProfile.containerName).pipe(
						Effect.catch(() => Effect.void),
						Effect.asVoid,
					);
					yield* Effect.addFinalizer(() =>
						traefikOps.forceRemove(routerProfile.containerName).pipe(
							Effect.catch(() => Effect.void),
							Effect.asVoid,
						),
					);
				}
				yield* router.boot().pipe(Effect.orDie);
				const builtInPluginContext = yield* extendBuiltInPluginContext(pluginContext);
				const handle = yield* supervise(
					{ _tag: 'Stack', members: stack.members, options: stack.options },
					identity,
					state,
					builtInPluginContext,
					contributionDispatcher,
				);
				// Wire the snapshot-bounce resume to a stack restart (drain ∘
				// converge): after the bounce hard-rms the captured/restored
				// containers, the converge recreates them from the retagged images
				// and blocks on each plugin's ready-gate (walrus = write-ready), so
				// the post-capture probe writes against a write-ready committee.
				resumeStack = handle.runCommand({ tag: 'stack.restart' });

				const readyKeys: string[] = [];
				const failures: Array<{ key: string; cause: string }> = [];
				const readyValues = new Map<string, unknown>();
				for (const [key] of handle.graph.nodes) {
					const exit = yield* handle.registry.awaitReady(key).pipe(Effect.exit);
					if (exit._tag === 'Failure') {
						failures.push({ key: key as string, cause: Cause.pretty(exit.cause) });
					} else {
						readyKeys.push(key as string);
						readyValues.set(key as string, exit.value);
					}
				}
				// After a capture/restore resume the bounce recreated every
				// container, so each plugin's live resolved value (held in the
				// registry's resolved map, refreshed on the re-acquire's markReady)
				// is NEW. Re-read it into the shared `readyValues` map IN PLACE so
				// `withinScope` consumers that rebuild their env (the matrix probes
				// rebuild `makeEnv` post-capture) pick up the fresh, write-ready
				// clients instead of the dead pre-bounce ones.
				refreshResolvedValues = Effect.sync(() => {
					for (const [key] of handle.graph.nodes) {
						const fresh = readResolvedSync(handle.registry, key);
						if (fresh !== undefined) readyValues.set(key as string, fresh);
					}
				});

				let digest: string | null = null;
				let createdObjectCount: number | null = null;
				if (digestFromKey !== '') {
					const resolved = readyValues.get(digestFromKey);
					if (resolved && typeof resolved === 'object') {
						if ('digest' in resolved) {
							const d = (resolved as { digest?: unknown }).digest;
							if (typeof d === 'string') digest = d;
						}
						if ('objectChanges' in resolved) {
							const oc = (resolved as { objectChanges?: unknown }).objectChanges;
							if (Array.isArray(oc)) {
								createdObjectCount = oc.filter(
									(c) =>
										c !== null &&
										typeof c === 'object' &&
										'kind' in c &&
										(c as { kind?: unknown }).kind === 'created',
								).length;
							}
						}
					}
				}

				if (opts.withinScope !== undefined) {
					yield* opts
						.withinScope({
							resolvedValues: readyValues,
							containerRuntime,
							strategyRegistry: registry,
							identity,
							snapshot: snapshotFacade,
							runCommand: handle.runCommand,
							readResolved: (key: string) =>
								readResolvedSync(handle.registry, key as Parameters<typeof readResolvedSync>[1]),
						})
						.pipe(Effect.orDie);
				}

				const snap = yield* SubscriptionRef.get(state);
				let codegenRun: BootCodegenRun | null = null;
				if (opts.runCodegen === true) {
					// Boot no longer emits a codegen tree — it assembles + writes
					// the deployment (the live on-chain ids the Vite plugin injects).
					// Mirror the production post-acquire path so the e2e exercises
					// the real deployment write/round-trip.
					const deployment = yield* codegen.assembleDeployment('localnet').pipe(Effect.orDie);
					const deploymentFile = join(codegenOutputDir, DEPLOYMENT_FILENAME);
					yield* fs.makeDirectory(codegenOutputDir, { recursive: true }).pipe(Effect.orDie);
					yield* writeDeployment(deploymentFile, deployment).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.orDie,
					);
					codegenRun = {
						outputDir: codegenOutputDir,
						deploymentFile,
						deployment,
					} satisfies BootCodegenRun;
				}
				const routerAppliedRoutes = yield* SubscriptionRef.get(router.applied);
				return {
					readyKeys,
					failures,
					topLevelErrorCount: snap.errors.length,
					digestFromKey: digest,
					createdObjectCount,
					resolvedValues: readyValues,
					runtimeRoot,
					routerDispatchDir,
					routerAppliedRoutes,
					codegenOutputDir,
					codegenRun,
				} satisfies BootResult;
			}),
		).pipe(Effect.provide(layerBuiltInPluginRuntime));

		return result;
	});

	return Effect.runPromise(
		program.pipe(
			Effect.provide(substrateLayers),
			// Quiet logger — substrate's pretty trace would interleave
			// with vitest reporter output.
			Effect.provide(Logger.layer([])),
		) as Effect.Effect<BootResult, unknown, never>,
	);
};
