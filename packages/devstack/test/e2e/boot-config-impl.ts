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

import { Cause, Context, Effect, FileSystem, Layer, Logger, Ref, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { readStackEngine, type Stack } from '../../src/api/define-devstack.ts';
import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
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
import {
	ArtifactPublisherService,
	layerArtifactPublisher,
} from '../../src/substrate/runtime/artifact-publisher/index.ts';
import { layerEntrypointRegistry } from '../../src/orchestrators/router/entrypoints.ts';
import { BUILT_IN_ENTRYPOINTS } from '../../src/plugins/router-entrypoints.ts';
import type { ResolvedRoute } from '../../src/orchestrators/router/file-provider.ts';
import {
	RouterService,
	UpstreamResolverService,
	layerRouterConfigLiteral,
	layerRouterService,
} from '../../src/orchestrators/router/service.ts';
import type { EndpointUrl } from '../../src/orchestrators/router/service.ts';
import { layerTraefikContainerOpsStub } from '../../src/orchestrators/router/traefik-container.ts';
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
	type RunEmitCycleResult,
} from '../../src/orchestrators/codegen/service.ts';
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
import {
	bootRouterOrchestrator,
	buildProductionOrchestratorSinks,
	layerManifestEndpointRegistry,
	productionRouterProfile,
} from '../../src/orchestrators/runtime-composition.ts';
import {
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
} from '../../src/runtime/built-in-plugin-layers.ts';
import {
	SnapshotOrchestratorService,
	layerSnapshotOrchestrator,
	type SnapshotCatalogEntry,
	type SnapshotMetadata,
} from '../../src/orchestrators/snapshot/index.ts';
import {
	ContainerRuntimeService,
	DockerSpawner,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
	layerDockerHostDefault,
} from '../../src/runtime/docker/index.ts';

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
	readonly withinScope?: (ctx: BootScopeContext) => Effect.Effect<void, never, never>;
	/** Seam-only opt-in: run the stub-backed codegen cycle after all
	 *  plugins reach ready. Output is always rooted under this boot's
	 *  temp runtime dir, never under examples/src. */
	readonly runCodegen?: boolean;
};

export interface BootRoutableDelivery {
	readonly pluginKey: string;
	readonly endpoint: EndpointUrl;
}

export interface BootCodegenableDelivery {
	readonly pluginKey: string;
	readonly emitterName: string;
	readonly outputPath: string;
	readonly sensitive: boolean;
}

export interface BootCodegenRun {
	readonly outputDir: string;
	readonly result: RunEmitCycleResult;
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
	readonly routerEndpoints: ReadonlyArray<BootRoutableDelivery>;
	readonly routerAppliedRoutes: ReadonlyArray<ResolvedRoute>;
	readonly codegenOutputDir: string;
	readonly codegenables: ReadonlyArray<BootCodegenableDelivery>;
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

export const runBoot = async (opts: BootOptions): Promise<BootResult> => {
	const identity: Identity = {
		app: appName(opts.appName),
		stack: stackName(opts.stackName),
		chain: chainId(opts.chainId ?? 'sui:local'),
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
	const withArtifactPublisher = layerArtifactPublisher.pipe(Layer.provideMerge(withCache));
	const withCoinRegistry = layerCoinRegistry.pipe(Layer.provideMerge(withArtifactPublisher));
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
	const withRouter = layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				platformBase,
				layerEntrypointRegistry(BUILT_IN_ENTRYPOINTS),
				layerTraefikContainerOpsStub,
				fakeRouterUpstreams,
				layerRouterConfigLiteral({
					disabled: false,
					profile: routerProfile,
					image: 'traefik:v3.5',
				}),
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
				layerCodegenRoot({ outputDir: codegenOutputDir, stackSubdir: null }),
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
		const publisher = yield* ArtifactPublisherService;
		const packageRegistry = yield* PackageRegistryService;
		const coinRegistry = yield* CoinRegistryService;
		const portBroker = yield* PortBrokerService;
		const leaseBroker = yield* LeaseBrokerService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const router = yield* RouterService;
		const codegen = yield* CodegenOrchestratorService;

		const pluginContext = Context.empty().pipe(
			Context.add(IdentityContext, identityCtx),
			Context.add(RuntimeRoot, runtimeRootResolved),
			Context.add(StackPathsService, stackPaths),
			Context.add(CacheService, cache),
			Context.add(StrategyRegistryService, registry),
			Context.add(ContainerRuntimeService, containerRuntime),
			Context.add(ArtifactPublisherService, publisher),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PortBrokerService, portBroker),
			Context.add(LeaseBrokerService, leaseBroker),
			Context.add(PostAcquireTasksService, postAcquireTasks),
		) as Context.Context<never>;

		const state = yield* makeProjectionRef();
		const routerEndpointRef = yield* Ref.make<ReadonlyArray<BootRoutableDelivery>>([]);
		const codegenableRef = yield* Ref.make<ReadonlyArray<BootCodegenableDelivery>>([]);
		const orchestratorSinks = yield* buildProductionOrchestratorSinks({
			routable: (pluginKey, endpoint) =>
				Ref.update(routerEndpointRef, (xs) => [...xs, { pluginKey: String(pluginKey), endpoint }]),
			codegenable: (pluginKey, decl) =>
				Ref.update(codegenableRef, (xs) => [
					...xs,
					{
						pluginKey: String(pluginKey),
						emitterName: decl.emitterName,
						outputPath: decl.outputPath,
						sensitive: decl.sensitive === true,
					},
				]),
		});
		const provideFileSystem = <A, E>(
			effect: Effect.Effect<A, E, FileSystem.FileSystem>,
		): Effect.Effect<A, E, never> => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));
		const snapshotFacade: BootSnapshotFacade = {
			capture: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					return yield* provideFileSystem(snapshot.capture({ id }));
				}),
			captureMetadata: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					return yield* provideFileSystem(snapshot.capture({ id }));
				}),
			restore: (id) => provideFileSystem(snapshot.restore({ id })),
			list: provideFileSystem(snapshot.list),
		};

		// supervise() + per-plugin awaitReady inside a Scope so finalizers
		// run before we read the projection snapshot.
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				// Router traffic itself is not exercised here: the e2e
				// harness injects a stub Traefik container layer plus a
				// fake upstream resolver, while using the same sink delivery
				// path as production.
				yield* bootRouterOrchestrator;
				const builtInPluginContext = yield* extendBuiltInPluginContext(pluginContext);
				const handle = yield* supervise(
					{ _tag: 'Stack', members: stack.members, options: stack.options },
					identity,
					state,
					builtInPluginContext,
					orchestratorSinks,
				);

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
					yield* opts.withinScope({
						resolvedValues: readyValues,
						containerRuntime,
						strategyRegistry: registry,
						identity,
						snapshot: snapshotFacade,
					});
				}

				const snap = yield* SubscriptionRef.get(state);
				const codegenables = yield* Ref.get(codegenableRef);
				const codegenRun =
					opts.runCodegen === true
						? ({
								outputDir: codegenOutputDir,
								result: yield* codegen.runCycle().pipe(Effect.orDie),
							} satisfies BootCodegenRun)
						: null;
				const routerEndpoints = yield* Ref.get(routerEndpointRef);
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
					routerEndpoints,
					routerAppliedRoutes,
					codegenOutputDir,
					codegenables,
					codegenRun,
				} satisfies BootResult;
			}),
		).pipe(Effect.provide(layerBuiltInPluginRuntime(orchestratorSinks)));

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
