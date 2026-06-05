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
} from '../../src/orchestrators/router/traefik-container.ts';
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
	type SnapshotCatalogEntry,
	type SnapshotMetadata,
} from '../../src/orchestrators/snapshot/index.ts';
import { computeWarmFingerprint } from '../../src/orchestrators/warm/fingerprint.ts';
import {
	runWarmCapture,
	runWarmRestore,
	type WarmHookDeps,
} from '../../src/orchestrators/warm/hooks.ts';
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
	/** Opt-in: drive the PRODUCTION warm boot-cache path. When set, the
	 *  warm-restore hook runs BEFORE the initial acquire (restoring the
	 *  baseline in place of a cold boot on a fingerprint HIT) and the
	 *  warm-capture hook runs AFTER the stack is up + the test `withinScope`
	 *  (capturing the baseline + writing the sidecar unless this boot was a
	 *  restore) — the EXACT closures `cli/wirings/up.ts` runs, so this puts
	 *  the e2e on the same warm path as `devstack up --warm`. The warm
	 *  fingerprint sha256s `configPath`'s bytes as its primary signal, so the
	 *  config file MUST exist (an unreadable config degrades to a cold boot).
	 *  `appRoot` roots watched Move-source discovery; `devstackVersion`
	 *  defaults to a stable sentinel. Pair with a persisted `runtimeRoot`
	 *  across invocations so a later boot observes the on-disk baseline. */
	readonly warm?: {
		readonly appRoot: string;
		readonly configPath: string;
		readonly devstackVersion?: string;
	};
};

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

export const runBoot = async (opts: BootOptions): Promise<BootResult> => {
	const identity: Identity = {
		app: appName(opts.appName),
		stack: stackName(opts.stackName),
		chain: opts.chainId ?? 'sui:local',
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
	const codegenExtrasDir = join(runtimeRoot, 'generated-extras');

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
						layerEntrypointRegistry(BUILT_IN_ENTRYPOINTS),
						layerTraefikContainerOpsDocker,
						layerDockerUpstreamResolver(routerProfile),
						routerConfig,
					).pipe(Layer.provideMerge(withSpawnerAdapter))
				: Layer.mergeAll(
						platformBase,
						layerEntrypointRegistry(BUILT_IN_ENTRYPOINTS),
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
					extrasDir: codegenExtrasDir,
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
		const snapshotFacade: BootSnapshotFacade = {
			capture: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					const meta = yield* provideFileSystem(
						snapshot.capture({ id, resume: Effect.orDie(resumeStack) }),
					);
					yield* refreshResolvedValues;
					return meta;
				}),
			captureMetadata: (id) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					const meta = yield* provideFileSystem(
						snapshot.capture({ id, resume: Effect.orDie(resumeStack) }),
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

		// ── Warm boot-cache hooks (opt-in via `opts.warm`) ────────────────────
		// Drive the EXACT production warm path (`cli/wirings/up.ts`): restore the
		// baseline before the initial acquire on a fingerprint HIT, capture it
		// after the stack is up unless this boot was a restore. The two shared
		// Refs are the same cells the production hooks pass — `warmRestoredRef`
		// flags a restore so the capture skips; `warmFingerprintRef` carries the
		// restore-phase fingerprint into the sidecar write. The snapshot ops
		// inject `resume: resumeStack` lazily (read at call time): warm-restore
		// runs BEFORE `supervise()` so `resumeStack` is still `void` then (the
		// `supervise()` acquire IS the converge, mirroring production's
		// `beforeInitialAcquire`); warm-capture runs AFTER, by which point
		// `resumeStack` is the stack restart, so the captured stack comes back
		// live exactly like `snapshotFacade.capture`.
		const warmRestoredRef = yield* Ref.make(false);
		const warmFingerprintRef = yield* Ref.make<string | null>(null);
		const warmDeps = (warmOpts: NonNullable<BootOptions['warm']>): WarmHookDeps => ({
			snapshot: {
				list: snapshot.list,
				restore: (args: { readonly id: string }) =>
					snapshot.restore({ id: args.id, resume: Effect.orDie(resumeStack) }).pipe(
						Effect.tap(() => refreshResolvedValues),
					),
				delete: (id: string) => snapshot.delete(id),
				capture: (args: { readonly id: string; readonly label?: string }) =>
					snapshot
						.capture({
							id: args.id,
							...(args.label === undefined ? {} : { label: args.label }),
							resume: Effect.orDie(resumeStack),
						})
						.pipe(Effect.tap(() => refreshResolvedValues)),
			},
			fs,
			stackRoot: stackPaths.stackRoot,
			computeFingerprint: computeWarmFingerprint({
				stack: { _tag: 'Stack' as const, members: stack.members, options: stack.options },
				appRoot: warmOpts.appRoot,
				configPath: warmOpts.configPath,
				devstackVersion: warmOpts.devstackVersion ?? '0.0.0-e2e',
			}),
			warmRestoredRef,
			warmFingerprintRef,
		});

		// supervise() + per-plugin awaitReady inside a Scope so finalizers
		// run before we read the projection snapshot.
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				// Router traffic itself is not exercised here: the e2e
				// harness injects a stub Traefik container layer plus a
				// fake upstream resolver, while using the same sink delivery
				// path as production. Production boots the router via the same
				// `router.boot()` call (see boot.ts dispatcher).
				yield* router.boot().pipe(Effect.orDie);
				// WARM-RESTORE — runs BEFORE the initial acquire (the `supervise()`
				// below), exactly like production's `beforeInitialAcquire`. On a
				// fingerprint HIT it restores the baseline tree; the `supervise()`
				// acquire then converges onto it. On a MISS it drops a stale baseline
				// and falls through to a cold boot. Never fails (wraps itself).
				if (opts.warm !== undefined) {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					yield* runWarmRestore(warmDeps(opts.warm));
				}
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
				refreshResolvedValues = Effect.gen(function* () {
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
					yield* opts.withinScope({
						resolvedValues: readyValues,
						containerRuntime,
						strategyRegistry: registry,
						identity,
						snapshot: snapshotFacade,
					}).pipe(Effect.orDie);
				}

				// WARM-CAPTURE — runs AFTER the stack is up + the test `withinScope`
				// (so a marker the test minted is in the captured tree), exactly like
				// production's warm `withinScope`. Captures the baseline + writes the
				// sidecar UNLESS this boot was itself a restore (`warmRestoredRef`).
				// Swallows its own failure.
				if (opts.warm !== undefined) {
					yield* fs.makeDirectory(stackPaths.stackRoot, { recursive: true });
					yield* runWarmCapture(warmDeps(opts.warm));
				}

				const snap = yield* SubscriptionRef.get(state);
				const codegenRun =
					opts.runCodegen === true
						? ({
								outputDir: codegenOutputDir,
								result: yield* codegen.runCycle().pipe(Effect.orDie),
							} satisfies BootCodegenRun)
						: null;
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
