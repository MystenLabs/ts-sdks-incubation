// Single L3 boot seam.
//
// Merges the former `run.ts` (substrate lifecycle + supervise entrypoint),
// `runtime-composition.ts` (production orchestrator assembly + contribution
// dispatcher + post-acquire hook), and `built-in-plugin-layers.ts` (built-in
// coin/package registry layers) into one module. Consumed by both the CLI
// verb wirings (`cli/wirings/*`) and the library-facing programmatic surface
// (`api/run-stack.ts`), plus the e2e boot harness.
//
// Composes the substrate Layer stack (L0) + the Docker `ContainerRuntime`
// adapter (L1), yields the substrate services into a `Context.Context<never>`
// pluginContext, builds the projection ref, and runs `supervise()` inside a
// scope. The production orchestrator assembly (Snapshot/Router/Codegen/
// ManifestEndpoint) and the contribution-delivery dispatcher live here too —
// the supervisor holds the dispatcher record opaquely (it never imports an
// orchestrator service).
//
// Architecture: this is L3 (orchestrator-level). Layer composition that
// assembles L0+L1 stacks belongs at L3/L4 — it can't live in `substrate/`
// because it imports a concrete L1 adapter (Docker) by definition; and it
// depends on L2 plugin internals (coin/package registries), so it can't live
// at L1 runtime either. See ARCHITECTURE.md § "Layer composition belongs at
// L3/L4, not L0" and § "L1-never-imports-from-L2".

import { Context, Effect, FileSystem, Layer, Ref, Scope, SubscriptionRef } from 'effect';
import { isAbsolute, join, resolve } from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { Identity } from '../substrate/identity.ts';
import { CacheService, layerCache } from '../substrate/runtime/cache/index.ts';
import { LeaseBrokerService, layerLeaseBroker } from '../substrate/runtime/lease-broker/index.ts';
import {
	IdentityContext,
	RuntimeRoot,
	StackPathsService,
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
} from '../substrate/runtime/paths.ts';
import { PortBrokerService, layerPortBroker } from '../substrate/runtime/port-broker/index.ts';
import {
	StrategyRegistryService,
	layerStrategyRegistry,
} from '../substrate/runtime/strategy-registry/index.ts';
import {
	ContainerRuntimeService,
	DockerSpawner,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
	layerDockerHostDefault,
} from '../runtime/docker/index.ts';
import { awaitAll, readResolvedSync } from '../substrate/runtime/lifecycle/index.ts';
import { operationalEndpointEventsFromResolvedValue } from '../substrate/runtime/projection/operational-endpoints.ts';
import { Logger, layerLogger } from '../substrate/runtime/observability/index.ts';
import {
	PostAcquireTasksService,
	layerPostAcquireTasks,
} from '../substrate/runtime/post-acquire-tasks.ts';
import {
	startSupervisor,
	type ContributionDispatcher,
	type SupervisedStack,
	type SupervisorCommandHandler,
	type SupervisorHandle,
	type SupervisorPostAcquireHook,
} from '../substrate/runtime/supervisor/index.ts';
import type { ContributionDispatchContext } from '../substrate/runtime/supervisor/contribution-dispatcher.ts';
import type { SupervisorPostAcquireContext } from '../substrate/runtime/supervisor/index.ts';

import {
	layerMystenMoveCodegen,
	MoveCodegenService,
	MoveSummaryRunnerService,
} from './codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerDocker } from '../plugins/sui/move-summary-runner.ts';
import { CodegenPathsService, layerCodegenPaths, layerCodegenRoot } from './codegen/paths.ts';
import { resolveCodegenOutput } from './codegen/output-location.ts';
import {
	CodegenOrchestratorService,
	layerCodegenOrchestrator,
	type Codegenable,
} from './codegen/service.ts';
import {
	DEFAULT_TRAEFIK_IMAGE,
	layerDockerUpstreamResolver,
	layerEntrypointRegistry,
	layerRouterConfigLiteral,
	layerRouterService,
	layerTraefikContainerOpsDocker,
	RouterService,
	type ResolvedRoute,
} from './router/index.ts';
import { BUILT_IN_ENTRYPOINTS } from '../plugins/router-entrypoints.ts';
import {
	makeDefaultRouterProfile,
	type DefaultRouterProfileOptions,
	type RouterProfile,
} from './router/profile.ts';
import { layerSnapshotOrchestrator, SnapshotOrchestratorService } from './snapshot/index.ts';
import type { ProjectionDecl } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';
import { endpointKey, type PluginKey } from '../substrate/brand.ts';
import type { EngineEvent } from '../substrate/events.ts';
import {
	buildEnvelope,
	CURRENT_MANIFEST_VERSION,
	writeManifest,
} from '../substrate/runtime/manifest/index.ts';
import {
	ManifestExtrasLookupError,
	resolveManifestExtras,
	type EndpointEntry,
	type ManifestExtrasInput,
} from '../substrate/manifest.ts';
import { CoinRegistryService, layerCoinRegistry } from '../plugins/coin/registry.ts';
import { PackageRegistryService, layerPackageRegistry } from '../plugins/package/registry.ts';

// ───────────────────────────────────────────────────────────────────────────
// Substrate lifecycle
// ───────────────────────────────────────────────────────────────────────────

/** Substrate Layer stack for a single supervised run. Composes every L0
 *  service the supervisor yields from its R-channel, plus the L1 Docker
 *  `ContainerRuntime`. Built-in plugin services are layered outside
 *  substrate and added through `extendContext`. */
export const buildSubstrateLayers = (identity: Identity, runtimeRoot: string) => {
	// DockerSpawner adapts platform-node's ChildProcessSpawner tag onto
	// the docker subsystem's local DockerSpawner tag (same shape; the
	// indirection only lets tests inject a stub).
	const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
		Layer.effect(
			DockerSpawner,
			Effect.gen(function* () {
				return yield* ChildProcessSpawner;
			}),
		);

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
	const withPortBroker = layerPortBroker.pipe(Layer.provideMerge(withCache));
	const withLeaseBroker = layerLeaseBroker.pipe(Layer.provideMerge(withPortBroker));
	const withSpawnerAdapter = layerDockerSpawnerFromNode.pipe(Layer.provideMerge(withLeaseBroker));
	const withContainerRuntime = layerContainerRuntimeDocker.pipe(
		Layer.provideMerge(withSpawnerAdapter),
	);
	const withPostAcquireTasks = layerPostAcquireTasks.pipe(Layer.provideMerge(withContainerRuntime));
	return layerLogger.pipe(Layer.provideMerge(withPostAcquireTasks));
};

/** Build the opaque `Context.Context<never>` the supervisor hands to
 *  every plugin's `acquire` body. Yields every substrate service the
 *  Docker-backed substrate layer stack provides; downstream callers
 *  may extend the context (e.g. layering the built-in plugin registries
 *  via `extendBuiltInPluginContext`) before passing it to `supervise()`. */
const buildPluginContext = (): Effect.Effect<
	Context.Context<never>,
	never,
	| IdentityContext
	| RuntimeRoot
	| StackPathsService
	| CacheService
	| StrategyRegistryService
	| ContainerRuntimeService
	| PortBrokerService
	| LeaseBrokerService
	| PostAcquireTasksService
	| Logger
> =>
	Effect.gen(function* () {
		const identityCtx = yield* IdentityContext;
		const runtimeRootResolved = yield* RuntimeRoot;
		const stackPaths = yield* StackPathsService;
		const cache = yield* CacheService;
		const registry = yield* StrategyRegistryService;
		const containerRuntime = yield* ContainerRuntimeService;
		const portBroker = yield* PortBrokerService;
		const leaseBroker = yield* LeaseBrokerService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const logger = yield* Logger;

		return Context.empty().pipe(
			Context.add(IdentityContext, identityCtx),
			Context.add(RuntimeRoot, runtimeRootResolved),
			Context.add(StackPathsService, stackPaths),
			Context.add(CacheService, cache),
			Context.add(StrategyRegistryService, registry),
			Context.add(ContainerRuntimeService, containerRuntime),
			Context.add(PortBrokerService, portBroker),
			Context.add(LeaseBrokerService, leaseBroker),
			Context.add(PostAcquireTasksService, postAcquireTasks),
			Context.add(Logger, logger),
		) as Context.Context<never>;
	});

/** Options accepted by the supervised-run entrypoint. `lifetime`
 *  selects long-running supervision versus a one-shot acquire/codegen
 *  cycle. The `beforeInitialAcquire` hook runs inside the supervised
 *  scope before the first acquire starts; live renderers use it to
 *  subscribe to startup projection changes. The `withinScope` hook
 *  runs after the first acquire completes.
 *
 *  Generic `R` widens the hook R-channel so callers can yield
 *  substrate services (e.g. `StackPathsService`) that are in scope at
 *  the supervisor-boot site. */
export interface SuperviseStackOptions<R = Scope.Scope, ExtendR = never, HookE = never> {
	readonly lifetime?: 'long-running' | 'one-shot';
	readonly beforeInitialAcquire?: (handle: SupervisorHandle) => Effect.Effect<void, HookE, R>;
	readonly withinScope?: (handle: SupervisorHandle) => Effect.Effect<void, HookE, R>;
	readonly commandHandler?: SupervisorCommandHandler;
	readonly contributionDispatcher?: ContributionDispatcher;
	readonly postAcquireHook?: SupervisorPostAcquireHook;
	/** Caller-supplied extension layered into `pluginContext` after the
	 *  default substrate context is built. Used by plugin-author Layer
	 *  composition (ARCHITECTURE.md § Plugin-author extension) and by
	 *  the CLI when it wants to inject the built-in plugin registries or
	 *  a custom Logger override. */
	readonly extendContext?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, ExtendR>;
}

/** Effect that boots the supervisor for `stack` and blocks on the
 *  supervisor's shutdown latch. Returns the final `SubscribableState`
 *  snapshot so callers (CLI, library handle) can inspect post-shutdown
 *  state. */
export const superviseStackEffect = <R = Scope.Scope, ExtendR = never, HookE = never>(
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<import('../substrate/projection.ts').SubscribableState>,
	opts: SuperviseStackOptions<R, ExtendR, HookE> = {},
) =>
	Effect.gen(function* () {
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const baseContext = yield* buildPluginContext();
				const pluginContext =
					opts.extendContext === undefined ? baseContext : yield* opts.extendContext(baseContext);

				const startup = yield* startSupervisor(
					stack,
					identity,
					state,
					pluginContext,
					opts.contributionDispatcher,
					opts.commandHandler,
					opts.postAcquireHook,
					{ commandLoop: opts.lifetime !== 'one-shot' },
				);
				const { handle } = startup;
				if (opts.beforeInitialAcquire !== undefined) {
					yield* opts.beforeInitialAcquire(handle);
				}
				if (opts.lifetime === 'one-shot') {
					yield* startup.runInitialAcquire;
					yield* awaitAll(startup.handle.registry, [...startup.handle.graph.nodes.keys()]);
					if (opts.withinScope !== undefined) {
						yield* opts.withinScope(handle);
					}
					return;
				}
				const outcome = yield* Effect.raceFirst(
					startup.runInitialAcquire.pipe(Effect.as('booted' as const)),
					handle.awaitShutdown.pipe(Effect.as('shutdown' as const)),
				);
				if (outcome === 'shutdown') {
					return;
				}
				if (opts.withinScope !== undefined) {
					yield* opts.withinScope(handle);
				}
				yield* handle.awaitShutdown;
			}),
		);
	});

/** End-to-end run: builds the substrate Layer stack, provides it to
 *  `superviseStackEffect`, applies a quiet Logger by default unless the
 *  caller passes one in `opts.loggerLayer`. The returned Effect has
 *  type `Effect<void, ..., never>` — all requirements are discharged
 *  by the layer stack composed here.
 *
 *  Callers that need to capture intermediate state (errors, terminal
 *  snapshot, etc.) supply `opts.withinScope` and read off the
 *  supervisor handle directly. */
// ───────────────────────────────────────────────────────────────────────────
// Production orchestrator assembly
// ───────────────────────────────────────────────────────────────────────────

export interface ProductionCodegenOptions {
	readonly appRoot?: string;
	readonly outputDir?: string;
	readonly stackSubdir?: string | null;
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for this stack. Threaded into `CodegenRoot.extrasDir`; recorded
	 *  in the manifest as `codegen.extrasDir` for the `@devstack-dev`
	 *  Vite alias. When omitted, falls back to
	 *  `<appRoot>/.devstack/stacks/<stack>/generated-extras` is NOT
	 *  derivable here (no stack name in scope), so the cold-start
	 *  default `<outputDir>/../generated-extras`-style fallback is left
	 *  to the resolver/Vite plugin; callers (`run-stack`, the CLI verb
	 *  wirings) always supply the resolved value. */
	readonly extrasDir?: string;
}

/** The per-stack codegen inputs the single seam needs: the app root, the
 *  resolved effective stack (already through the explicit-`--stack` >
 *  `config.stackName` > inferred ladder), the config's declared primary
 *  `stackName`, and the app's optional explicit `codegen` pins. */
export interface ProductionCodegenSeamInput {
	readonly appRoot: string;
	readonly effectiveStack: string;
	readonly primaryStack: string | undefined;
	readonly codegen?: { readonly outputDir?: string; readonly stackSubdir?: string | null } | undefined;
}

/**
 * The ONE boot seam that maps a stack's codegen config to the production
 * codegen orchestrator options. Both composition entry points
 * (`api/run-stack.ts` and `cli/wirings/build-verb-layers.ts`) call this so
 * the primary-vs-secondary output-dir branch (via `resolveCodegenOutput`)
 * is wired exactly once: primary run → `<appRoot>/src/generated`; a
 * secondary `--stack` run → `<appRoot>/.devstack/stacks/<stack>/generated`,
 * so the two never clobber. The resolved literal `outputDir`/`stackSubdir`/
 * `extrasDir` flow into `layerProductionOrchestrators({ codegen })`
 * unchanged — `paths.ts` keeps consuming literals (minimal blast radius).
 */
export const resolveProductionCodegenOptions = (
	input: ProductionCodegenSeamInput,
): ProductionCodegenOptions => {
	const resolved = resolveCodegenOutput({
		appRoot: input.appRoot,
		effectiveStack: input.effectiveStack,
		primaryStack: input.primaryStack,
		explicitOutputDir: input.codegen?.outputDir,
		explicitStackSubdir: input.codegen?.stackSubdir ?? null,
	});
	return {
		appRoot: input.appRoot,
		outputDir: resolved.outputDir,
		stackSubdir: resolved.stackSubdir,
		extrasDir: resolved.extrasDir,
	};
};

export interface ProductionRouterOptions {
	readonly codegen?: ProductionCodegenOptions;
	readonly disabled?: boolean;
	readonly image?: string;
	readonly profile?: RouterProfile;
}

export interface ProductionPostAcquireOptions {
	readonly extras?: ManifestExtrasInput;
}

export interface ManifestEndpointRegistry {
	readonly register: (entry: EndpointEntry) => Effect.Effect<void, never, Scope.Scope>;
	readonly entries: Effect.Effect<ReadonlyArray<EndpointEntry>>;
}

export class ManifestEndpointRegistryService extends Context.Service<
	ManifestEndpointRegistryService,
	ManifestEndpointRegistry
>()('@devstack/orchestrators/ManifestEndpointRegistry') {}

export const layerManifestEndpointRegistry: Layer.Layer<ManifestEndpointRegistryService> =
	Layer.effect(
		ManifestEndpointRegistryService,
		Effect.gen(function* () {
			const entriesRef = yield* Ref.make<ReadonlyArray<EndpointEntry & { readonly seq: number }>>(
				[],
			);
			const seqRef = yield* Ref.make(0);

			const register = (entry: EndpointEntry): Effect.Effect<void, never, Scope.Scope> =>
				Effect.gen(function* () {
					const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
					yield* Ref.update(entriesRef, (entries) => [...entries, { ...entry, seq }]);
					yield* Effect.addFinalizer(() =>
						Ref.update(entriesRef, (entries) =>
							entries.filter((candidate) => candidate.seq !== seq),
						),
					);
				});

			return ManifestEndpointRegistryService.of({
				register,
				entries: Ref.get(entriesRef).pipe(
					Effect.map((entries) =>
						entries.map((entryWithSeq) => {
							const { seq, ...entry } = entryWithSeq;
							void seq;
							return entry;
						}),
					),
				),
			});
		}),
	);

export const productionRouterProfile = (options: DefaultRouterProfileOptions = {}): RouterProfile =>
	makeDefaultRouterProfile(options);

const productionCodegenOutputDir = (appRoot: string, outputDir: string | undefined): string => {
	const target = outputDir ?? 'src/generated';
	return isAbsolute(target) ? target : resolve(appRoot, target);
};

/** Fallback `generated-extras` dir for the cold-start / no-config
 *  composition path (`buildDirectSnapshotLayers`). Callers that know
 *  their stack (`run-stack`, the verb wirings) pass the resolved
 *  per-stack value; this default only feeds direct-snapshot verbs that
 *  never run codegen. */
const productionCodegenExtrasDir = (appRoot: string, extrasDir: string | undefined): string => {
	const target = extrasDir ?? '.devstack/generated-extras';
	return isAbsolute(target) ? target : resolve(appRoot, target);
};

export const layerProductionOrchestrators = (router: ProductionRouterOptions = {}) => {
	const profile = router.profile ?? productionRouterProfile();
	return Layer.mergeAll(
		layerSnapshotOrchestrator,
		layerManifestEndpointRegistry,
		layerRouterService.pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					layerEntrypointRegistry(BUILT_IN_ENTRYPOINTS),
					layerTraefikContainerOpsDocker,
					layerDockerUpstreamResolver(profile),
					layerRouterConfigLiteral({
						disabled: router.disabled ?? false,
						profile,
						image: router.image ?? DEFAULT_TRAEFIK_IMAGE,
						routeReadinessProbe: {
							enabled: router.disabled !== true,
						},
					}),
				),
			),
		),
		layerCodegenOrchestrator,
		layerCodegenPaths.pipe(
			Layer.provideMerge(
				layerCodegenRoot({
					outputDir: productionCodegenOutputDir(
						router.codegen?.appRoot ?? process.cwd(),
						router.codegen?.outputDir,
					),
					stackSubdir: router.codegen?.stackSubdir ?? null,
					extrasDir: productionCodegenExtrasDir(
						router.codegen?.appRoot ?? process.cwd(),
						router.codegen?.extrasDir,
					),
				}),
			),
		),
		layerSuiMoveSummaryRunnerDocker,
		layerMystenMoveCodegen,
	);
};

/** All three sink-feeds for one routable endpoint, derived together. */
export interface EndpointSinks {
	/** Router sink: the post-mint `ResolvedRoute` the router wrote its
	 *  dispatch file from and publishes onto its `applied` ref. Carried
	 *  through verbatim so all three sinks derive from this ONE object. */
	readonly route: ResolvedRoute;
	/** Manifest sink: the on-disk manifest's `EndpointEntry`. */
	readonly manifestEntry: EndpointEntry;
	/** Projection sink: the `endpoint.registered` engine event. */
	readonly event: Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>;
}

/** The single adapter for routable endpoints: ONE `ResolvedRoute` (the
 *  router's post-mint source of truth) → ALL THREE sink-feeds at once —
 *  the router's own `route`, the manifest `EndpointEntry`, and the
 *  projection `endpoint.registered` event — derived from one shared
 *  field-set so the three sinks can never diverge. The `routable`
 *  dispatch body feeds each sink from the object this returns; there is
 *  no second, third derivation off the route anywhere.
 *
 *  It owns the url-derivation: `tcp` routes carry `tcp://127.0.0.1:port`,
 *  everything else `http://hostname:port`. Consumers (codegen, manifest)
 *  translate `tcp://` to their protocol-specific scheme (`postgres://`,
 *  `redis://`, …).
 *
 *  `ResolvedRoute` only carries `entrypointName`, so the endpoint name is
 *  recovered from the original `decl.endpointName`; `pluginKey` is supplied
 *  by the dispatcher (it is not in `ResolvedRoute`). Router-only fields
 *  (`dispatchFileId`/`cors`/`upstreamUrl`) are kept ON `route` for the
 *  router sink but discarded from the manifest/projection field-set — those
 *  schemas do not consume them. */
export const endpointSinksFromRoute = (
	decl: RoutableDecl,
	route: ResolvedRoute,
	pluginKey: PluginKey,
	registeredAt = Date.now(),
): EndpointSinks => {
	const url =
		route.wireProtocol === 'tcp'
			? `tcp://127.0.0.1:${route.entrypointPort}`
			: `http://${route.hostname}:${route.entrypointPort}`;
	const common = {
		name: decl.endpointName,
		url,
		displayUrl: null,
		wireProtocol: route.wireProtocol,
	} as const;
	const endpointKeyString = `${pluginKey}:${decl.endpointName}`;
	return {
		route,
		manifestEntry: {
			...common,
			endpointKey: endpointKeyString,
			pluginKey: String(pluginKey),
		},
		event: {
			tag: 'endpoint.registered',
			endpoint: {
				...common,
				endpointKey: endpointKey(endpointKeyString),
				pluginKey,
				registeredAt,
			},
		},
	};
};

const manifestEndpointEntryFromOperationalEndpoint = (
	endpoint: Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>['endpoint'],
): EndpointEntry => ({
	endpointKey: String(endpoint.endpointKey),
	name: endpoint.name,
	url: endpoint.url,
	displayUrl: endpoint.displayUrl,
	wireProtocol: endpoint.wireProtocol,
	pluginKey: String(endpoint.pluginKey),
});

/** Project a projection decl's `rowKey` (when absent) onto the
 *  contributing plugin so projection consumers can attribute the row.
 *  The payload stays opaque from the substrate's POV. */
const projectionDispatch = (
	decl: ProjectionDecl,
	ctx: ContributionDispatchContext,
): Effect.Effect<void, never, never> => {
	const payload = decl.event.payload;
	const payloadWithRowKey =
		payload !== null &&
		typeof payload === 'object' &&
		'rowKey' in payload &&
		(payload as { rowKey: unknown }).rowKey === null
			? { ...payload, rowKey: ctx.pluginKey }
			: payload;
	return ctx.publish({
		...decl.event,
		payload: payloadWithRowKey,
	});
};

/** Register a strategy contribution on the scope-local registry, publish
 *  `strategy.registered`, and arm a finalizer publishing
 *  `strategy.unregistered`. */
const strategyContributorDispatch = (
	decl: StrategyContributorDecl<string, unknown>,
	ctx: ContributionDispatchContext,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		yield* ctx.strategyRegistry.register(decl.capabilityKey, decl.strategy, {
			autoMounted: decl.autoMounted,
			...(decl.priority === undefined ? {} : { priority: decl.priority }),
		});
		yield* ctx.publish({
			tag: 'strategy.registered',
			capabilityKey: decl.capabilityKey,
			autoMounted: decl.autoMounted,
			at: Date.now(),
		});
		yield* Effect.addFinalizer(() =>
			ctx.publish({
				tag: 'strategy.unregistered',
				capabilityKey: decl.capabilityKey,
				at: Date.now(),
			}),
		);
	});

/**
 * Build the production `ContributionDispatcher` — the closed seam the
 * supervisor replays each plugin's buffered contributions through after
 * a successful `start`. Each method's body reads its backing orchestrator
 * service (Snapshot/Router/Codegen/ManifestEndpoint) ONCE here and closes
 * over it; the substrate supervisor holds the resulting record opaquely
 * (it never imports an orchestrator service).
 */
export const buildProductionContributionDispatcher = (): Effect.Effect<
	ContributionDispatcher,
	never,
	| SnapshotOrchestratorService
	| RouterService
	| CodegenOrchestratorService
	| ManifestEndpointRegistryService
> =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const router = yield* RouterService;
		const codegen = yield* CodegenOrchestratorService;
		const manifestEndpoints = yield* ManifestEndpointRegistryService;
		return {
			snapshotable: (decl: SnapshotableDecl, ctx) =>
				snapshot.registerParticipant(ctx.pluginKey, decl),
			routable: (decl: RoutableDecl, ctx) =>
				router.boot().pipe(
					// Router sink: `contributeRoute` writes the dispatch file +
					// publishes the route onto `applied`, returning the post-mint
					// `ResolvedRoute` — the ONE source of truth.
					Effect.andThen(router.contributeRoute(decl)),
					Effect.flatMap((route) => {
						// One adapter off that ResolvedRoute yields BOTH remaining
						// sink-feeds; feed manifest then projection. No second
						// derivation off the route lives anywhere.
						const sinks = endpointSinksFromRoute(decl, route, ctx.pluginKey);
						return manifestEndpoints
							.register(sinks.manifestEntry)
							.pipe(Effect.andThen(ctx.publish(sinks.event)));
					}),
				),
			codegenable: (decl: Codegenable, ctx) => codegen.registerContribution(ctx.pluginKey, decl),
			projection: (decl: ProjectionDecl, ctx) => projectionDispatch(decl, ctx),
			strategyContributor: (decl: StrategyContributorDecl<string, unknown>, ctx) =>
				strategyContributorDispatch(decl, ctx),
		} satisfies ContributionDispatcher;
	});

const makeManifestExtrasContext = (ctx: SupervisorPostAcquireContext) => {
	const resourceIdToKey = new Map<string, PluginKey>();
	for (const [key, node] of ctx.graph.nodes) {
		resourceIdToKey.set(node.member.id, key);
	}
	// `lookup` throws `ManifestExtrasLookupError` synchronously from
	// inside the user-supplied `extras` factory.
	// `resolveManifestExtras` invokes that factory under `Effect.try`
	// with a typed `catch` mapper, so the throw promotes to the typed
	// failure channel — callers `catchTag('ManifestExtrasLookupError',
	// ...)` rather than reading the die-cause. Non-tagged throws stay
	// defects, preserving the previous semantics for genuine
	// programmer errors inside the factory body.
	const lookup = (resourceId: string): unknown => {
		const key = resourceIdToKey.get(resourceId);
		if (key === undefined) {
			throw new ManifestExtrasLookupError({
				kind: 'unknown-resource',
				resourceId,
			});
		}
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) {
			throw new ManifestExtrasLookupError({
				kind: 'unresolved-resource',
				resourceId,
			});
		}
		return resolved;
	};
	return {
		value: (resource: { readonly id: string }) => lookup(resource.id),
	};
};

const operationalManifestEndpointEntries = (
	ctx: SupervisorPostAcquireContext,
	routableEntries: ReadonlyArray<EndpointEntry>,
): ReadonlyArray<EndpointEntry> => {
	const routablePluginKeys = new Set(routableEntries.map((entry) => entry.pluginKey));
	const registeredAt = Date.now();
	const entries: EndpointEntry[] = [];
	for (const [key] of ctx.graph.nodes) {
		if (routablePluginKeys.has(String(key))) continue;
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) continue;
		for (const event of operationalEndpointEventsFromResolvedValue(key, resolved, registeredAt)) {
			entries.push(manifestEndpointEntryFromOperationalEndpoint(event.endpoint));
		}
	}
	return entries;
};

export const buildProductionPostAcquireHook = (
	options: ProductionPostAcquireOptions = {},
): Effect.Effect<
	SupervisorPostAcquireHook,
	never,
	| CodegenOrchestratorService
	| CodegenPathsService
	| MoveSummaryRunnerService
	| MoveCodegenService
	| FileSystem.FileSystem
	| StackPathsService
	| PostAcquireTasksService
	| ManifestEndpointRegistryService
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const summaryRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		const fs = yield* FileSystem.FileSystem;
		const stackPaths = yield* StackPathsService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const manifestEndpoints = yield* ManifestEndpointRegistryService;
		return (ctx) =>
			Effect.gen(function* () {
				const extras = yield* resolveManifestExtras(options.extras, makeManifestExtrasContext(ctx));
				const routableEndpoints = yield* manifestEndpoints.entries;
				const endpoints = [
					...routableEndpoints,
					...operationalManifestEndpointEntries(ctx, routableEndpoints),
				];
				const envelope = yield* buildEnvelope({
					identity: {
						app: ctx.identity.app,
						stack: ctx.identity.stack,
						chain: ctx.identity.chain,
					},
					contributions: [],
					endpoints,
					extras,
					// Record the EXACT dirs codegen emits into for this stack so
					// the read-side `@generated` / `@devstack-dev` aliases (the
					// Vite plugin) point where the files actually are — one
					// decision, one source of truth
					// (notes/per-stack-codegen-design.md §"Resolved: read and
					// write share one gate"). `paths.outputDir` is the resolved,
					// stack-subdir-applied absolute path the runtime tree writes
					// to; `paths.extrasDir` is the dev-only `generated-extras`
					// tree the `@devstack-dev` alias resolves.
					codegen: { generatedDir: paths.outputDir, extrasDir: paths.extrasDir },
				});
				const manifestPath = join(stackPaths.stackRoot, 'manifest.json');
				yield* writeManifest(envelope, manifestPath).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
				);
				const result = yield* codegen
					.runCycle()
					.pipe(
						Effect.provideService(CodegenPathsService, paths),
						Effect.provideService(MoveSummaryRunnerService, summaryRunner),
						Effect.provideService(MoveCodegenService, moveCodegen),
						Effect.provideService(FileSystem.FileSystem, fs),
					);
				yield* postAcquireTasks.runAll;
				return [
					{
						tag: 'manifest.flushed' as const,
						manifestVersion: CURRENT_MANIFEST_VERSION,
						at: Date.now(),
					},
					{
						tag: 'codegen.emitted' as const,
						files: [
							...result.filesWritten,
							...result.filesChmod,
							...(result.bindings?.filesWritten ?? []),
						],
						at: Date.now(),
					},
				];
			});
	});

// ───────────────────────────────────────────────────────────────────────────
// Built-in plugin runtime composition
//
// Depends on L2 plugin internals (coin/package registries), so it can't live
// at L1 runtime — hence its home in this L3 boot module.
// ───────────────────────────────────────────────────────────────────────────

/** Built-in plugin runtime: the per-stack coin + package registries.
 *  Coin auto-discovery from a fresh package publish now runs DIRECTLY in
 *  the package plugin's `start` (folding the publish output into the
 *  CoinRegistry), so the registries are the whole surface. */
export const layerBuiltInPluginRuntime: Layer.Layer<CoinRegistryService | PackageRegistryService> =
	Layer.mergeAll(layerCoinRegistry, layerPackageRegistry);

export const extendBuiltInPluginContext = (
	ctx: Context.Context<never>,
): Effect.Effect<
	Context.Context<never>,
	never,
	CoinRegistryService | PackageRegistryService | SnapshotOrchestratorService | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const coinRegistry = yield* CoinRegistryService;
		const packageRegistry = yield* PackageRegistryService;
		// Thread the snapshot orchestrator + filesystem into the plugin
		// runtime context so the supervisor can populate the control-plane
		// `domain` surface (snapshot list/restore/delete, which never
		// round-trip through the void `publishCommand`). The
		// `ContainerRuntimeService` the domain also needs is already in the
		// base substrate plugin context.
		const snapshotOrchestrator = yield* SnapshotOrchestratorService;
		const fileSystem = yield* FileSystem.FileSystem;
		return ctx.pipe(
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(SnapshotOrchestratorService, snapshotOrchestrator),
			Context.add(FileSystem.FileSystem, fileSystem),
		) as Context.Context<never>;
	});

export type { ResolvedRoute };
