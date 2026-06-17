// Single L3 boot seam.
//
// Consumed by both the CLI verb wirings (`cli/wirings/*`) and the
// library-facing programmatic surface (`api/run-stack.ts`), plus the e2e
// boot harness.
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
import { readResolvedSync } from '../substrate/runtime/lifecycle/index.ts';
import { operationalEndpointEventsFromResolvedValue } from '../substrate/runtime/projection/operational-endpoints.ts';
import { Logger, layerLogger } from '../substrate/runtime/observability/index.ts';
import {
	PostAcquireTasksService,
	layerPostAcquireTasks,
} from '../substrate/runtime/post-acquire-tasks.ts';
import {
	allReadyOrTerminal,
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
import { CodegenWriteFailed } from './codegen/errors.ts';
import { ID_CONFIG_FILENAME, writeIdConfig } from './codegen/id-config.ts';
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
import { resolveNetworkOptions } from './network-options.ts';
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
	readonly devstackVersion?: string;
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
					{
						commandLoop: opts.lifetime !== 'one-shot',
						...(opts.devstackVersion === undefined
							? {}
							: { devstackVersion: opts.devstackVersion }),
					},
				);
				const { handle } = startup;
				if (opts.beforeInitialAcquire !== undefined) {
					yield* opts.beforeInitialAcquire(handle);
				}
				if (opts.lifetime === 'one-shot') {
					// `runInitialAcquire` runs `acquireFullGraph` to completion (every
					// node reaches a terminal status) before it returns. Gate the
					// one-shot `withinScope` on the SUPERVISOR-OWNED readiness signal
					// — `allReadyOrTerminal` (`ready || done`) — NOT a per-node
					// `awaitReady` watcher. A run-to-completion `task` node lands in
					// `done`; the registry contract admits a `done`-status node whose
					// `readyGate` is unresolved (only `markReady`/`markFailed` resolve
					// it), so a per-node gate HANGS on it. This is the SAME
					// `done`-tolerant gate S1 gave the long-running path; reading
					// statuses never suspends, so it is hang-free.
					yield* startup.runInitialAcquire;
					yield* allReadyOrTerminal(startup.handle.graph, startup.handle.registry);
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

// ───────────────────────────────────────────────────────────────────────────
// Production orchestrator assembly
// ───────────────────────────────────────────────────────────────────────────

export interface ProductionCodegenOptions {
	readonly appRoot?: string;
	/** Resolved absolute path to the dev-only + secret `generated-extras`
	 *  tree for this stack, threaded into `CodegenRoot.extrasDir` and
	 *  recorded in the manifest as `codegen.extrasDir` for the
	 *  `@devstack-dev` Vite alias. This is the ONLY tree boot's codegen
	 *  writes (`emitExtras`); boot never emits the committed `src/generated`
	 *  tree, so it pins no live `outputDir` — the `CodegenRoot.outputDir`
	 *  the production path carries is an unwritten default. The committed
	 *  tree is owned solely by the stack-free `codegen` verb (wired
	 *  separately, where it resolves its own output path). */
	readonly extrasDir?: string;
	/** Forwarded verbatim to `@mysten/codegen`'s
	 *  `generateFromPackageSummary` via `layerMystenMoveCodegen` — see
	 *  `DevstackOptions['codegen']` for the full contract. Default `false`
	 *  (`@mysten/codegen`'s own default): phantom-only structs render as
	 *  consts with the phantom placeholder baked into `.name`; `true`
	 *  renders them as factories whose required type arguments compose a
	 *  fully-qualified type tag. */
	readonly includePhantomTypeParameters?: boolean;
}

/**
 * The ONE boot seam that maps a stack's codegen config to the production
 * codegen orchestrator options for a LIVE (`'ran'`) projection. Both
 * composition entry points (`api/run-stack.ts` and `orchestrators/layers.ts`)
 * call this so the live output-dir decision (via `resolveCodegenOutput`)
 * is wired exactly once: EVERY live run — including what used to be the
 * "primary" stack — emits into `<appRoot>/.devstack/stacks/<stack>/generated`,
 * so the id-bearing live tree never lands in the committed source tree and
 * two stacks never clobber. The committed `src/generated` tree is owned
 * solely by the stack-free `codegen` verb. The resolved literal
 * `outputDir`/`stackSubdir`/`extrasDir` flow into
 * `layerProductionOrchestrators({ codegen })` unchanged — `paths.ts` keeps
 * consuming literals (minimal blast radius).
 *
 * The per-stack inputs: the app root, the resolved effective stack
 * (already through the explicit-`--stack` > `config.stackName` > inferred
 * ladder), and the app's optional explicit `codegen` pins.
 */
export const resolveProductionCodegenOptions = (input: {
	readonly appRoot: string;
	readonly effectiveStack: string;
	readonly codegen?:
		| {
				readonly includePhantomTypeParameters?: boolean;
		  }
		| undefined;
}): ProductionCodegenOptions => {
	// Every live run resolves its dev tree to
	// `<appRoot>/.devstack/stacks/<stack>/generated-extras` (the default
	// rule). Nothing is ever emitted into the live `generated` tree at boot
	// (boot writes only the per-stack `generated-extras` overlay +
	// `devstack-ids.json`), so there is no live `outputDir` to resolve — the
	// committed `src/generated` tree is owned solely by the stack-free
	// `codegen` verb (wired separately).
	const resolved = resolveCodegenOutput({
		appRoot: input.appRoot,
		effectiveStack: input.effectiveStack,
	});
	return {
		appRoot: input.appRoot,
		extrasDir: resolved.extrasDir,
		// Pass-through verbatim — no resolution step; "unset" stays unset so
		// `@mysten/codegen`'s own default (false) applies at the call site.
		...(input.codegen?.includePhantomTypeParameters === undefined
			? {}
			: { includePhantomTypeParameters: input.codegen.includePhantomTypeParameters }),
	};
};

export interface ProductionRouterOptions {
	readonly codegen?: ProductionCodegenOptions;
	readonly disabled?: boolean;
}

export class ManifestEndpointRegistryService extends Context.Service<
	ManifestEndpointRegistryService,
	{
		readonly register: (entry: EndpointEntry) => Effect.Effect<void, never, Scope.Scope>;
		readonly entries: Effect.Effect<ReadonlyArray<EndpointEntry>>;
	}
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

/** `outputDir` for the `CodegenRoot` of a `layerProductionOrchestrators`
 *  composition. The production codegen path NEVER emits the committed
 *  `src/generated` tree (boot writes only `generated-extras` via
 *  `emitExtras`), so this directory is never written — it only has to wire
 *  a valid, non-crashing `CodegenRoot`. It resolves to `<appRoot>/src/generated`
 *  by convention. The committed tree is owned solely by the stack-free
 *  `codegen` verb (wired separately, where it pins its own output path). */
const productionCodegenOutputDir = (appRoot: string): string => resolve(appRoot, 'src/generated');

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
	const profile = productionRouterProfile();
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
						image: DEFAULT_TRAEFIK_IMAGE,
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
					outputDir: productionCodegenOutputDir(router.codegen?.appRoot ?? process.cwd()),
					stackSubdir: null,
					extrasDir: productionCodegenExtrasDir(
						router.codegen?.appRoot ?? process.cwd(),
						router.codegen?.extrasDir,
					),
				}),
			),
		),
		layerSuiMoveSummaryRunnerDocker,
		layerMystenMoveCodegen({
			includePhantomTypeParameters: router.codegen?.includePhantomTypeParameters,
		}),
	);
};

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
) => {
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
	const event: Extract<EngineEvent, { readonly tag: 'endpoint.registered' }> = {
		tag: 'endpoint.registered',
		endpoint: {
			...common,
			endpointKey: endpointKey(endpointKeyString),
			pluginKey,
			registeredAt,
		},
	};
	return {
		route,
		manifestEntry: {
			...common,
			endpointKey: endpointKeyString,
			pluginKey: String(pluginKey),
		},
		event,
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
	options: {
		readonly extras?: ManifestExtrasInput;
		readonly networkOptions?: Readonly<Record<string, unknown>>;
	} = {},
): Effect.Effect<
	SupervisorPostAcquireHook,
	never,
	| CodegenOrchestratorService
	| CodegenPathsService
	| FileSystem.FileSystem
	| StackPathsService
	| PostAcquireTasksService
	| ManifestEndpointRegistryService
	| MoveSummaryRunnerService
	| MoveCodegenService
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const fs = yield* FileSystem.FileSystem;
		const stackPaths = yield* StackPathsService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const manifestEndpoints = yield* ManifestEndpointRegistryService;
		// Yielded here (outside the per-ctx hook) so the conditional
		// `generated-extras` flush below can provide them to `emitExtras`.
		const moveRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		return (ctx) =>
			Effect.gen(function* () {
				const extras = yield* resolveManifestExtras(options.extras, makeManifestExtrasContext(ctx));
				const routableEndpoints = yield* manifestEndpoints.entries;
				const endpoints = [
					...routableEndpoints,
					...operationalManifestEndpointEntries(ctx, routableEndpoints),
				];
				// Boot no longer runs codegen. Its only job is to PRODUCE the
				// id-config (loadable on-chain ids), which the Vite plugin injects
				// via `__DEVSTACK_IDS__` in dev. The committed `src/generated` tree
				// is written ONLY by the stack-free `devstack codegen` verb.
				// Assemble the id-config from the SAME live-resolved contributions
				// that fed `config.ts` and write it to the gitignored
				// `.devstack/stacks/<stack>/`.
				const idConfig = yield* codegen.assembleIdConfig(String(ctx.identity.network)).pipe(
					Effect.mapError(
						(cause) =>
							new CodegenWriteFailed({
								outputPath: ID_CONFIG_FILENAME,
								stage: 'write',
								cause,
							}),
					),
				);
				const idsFile = join(stackPaths.stackRoot, ID_CONFIG_FILENAME);
				yield* writeIdConfig(idsFile, idConfig).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
				);
				const envelope = yield* buildEnvelope({
					identity: {
						app: ctx.identity.app,
						stack: ctx.identity.stack,
						network: ctx.identity.network,
					},
					endpoints,
					extras,
					// Record the dev-only `generated-extras` tree the
					// `@devstack-dev` Vite alias resolves and the live `idsFile`
					// the plugin injects as `__DEVSTACK_IDS__` — one decision, one
					// source of truth. Bindings are NOT recorded: `@generated`
					// always resolves to the committed `src/generated` tree written
					// by the stack-free `codegen` verb.
					codegen: { extrasDir: paths.extrasDir, idsFile },
				});
				const manifestPath = join(stackPaths.stackRoot, 'manifest.json');
				yield* writeManifest(envelope, manifestPath).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
				);
				// Conditionally flush the dev-only `generated-extras` tree
				// (dev wallet + accounts) — the ONE acquire-resolved surface the
				// stack-free `codegen` verb can't produce. Gated on the resolved
				// network's `devWallet` flag (per-network options, ON for every
				// network except live `mainnet`). When off, nothing is written
				// and the Vite plugin's `@devstack-dev` `load` hook no-ops.
				const netOpts = resolveNetworkOptions(ctx.identity.network, options.networkOptions);
				const extrasFiles: string[] = [];
				if (netOpts.devWallet) {
					const extras = yield* codegen
						.emitExtras()
						.pipe(
							Effect.provideService(FileSystem.FileSystem, fs),
							Effect.provideService(CodegenPathsService, paths),
							Effect.provideService(MoveSummaryRunnerService, moveRunner),
							Effect.provideService(MoveCodegenService, moveCodegen),
						);
					extrasFiles.push(...extras.filesWritten, ...extras.filesChmod);
				}
				yield* postAcquireTasks.runAll;
				return [
					{
						tag: 'manifest.flushed' as const,
						manifestVersion: CURRENT_MANIFEST_VERSION,
						at: Date.now(),
					},
					{
						tag: 'codegen.emitted' as const,
						files: [idsFile, ...extrasFiles],
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

// ───────────────────────────────────────────────────────────────────────────
// Production supervised-boot assembly — THE single dedup site
// ───────────────────────────────────────────────────────────────────────────

/** The per-caller inputs to {@link superviseStackWithProductionBoot} — the
 *  fields that GENUINELY differ between the long-running programmatic seam
 *  (`api/run-stack-internal.ts`) and the one-shot CLI verbs (`apply` /
 *  `snapshot`). Everything else — the contribution dispatcher, the
 *  post-acquire hook, and the built-in plugin-context extension — is
 *  assembled identically by the helper, so it lives in ONE place. */
export interface ProductionBootOptions<HookR = Scope.Scope, HookE = never, ExtendR = never> {
	/** `'one-shot'` runs the acquire/codegen cycle then returns; the default
	 *  `'long-running'` supervises until shutdown. */
	readonly lifetime?: 'long-running' | 'one-shot';
	readonly devstackVersion?: string;
	/** Threaded into `buildProductionPostAcquireHook` — the stack's manifest
	 *  `extras`. All three callers pass `stack.options.extras`. */
	readonly extras?: ManifestExtrasInput;
	/** Threaded into `buildProductionPostAcquireHook` — the stack's
	 *  per-network options. The hook resolves the active network's slice to
	 *  decide whether to flush the dev-only `generated-extras` tree. All
	 *  three callers pass `stack.options.networkOptions`. */
	readonly networkOptions?: Readonly<Record<string, unknown>>;
	/** The resolved supervisor command handler (run-stack's snapshot bridge).
	 *  One-shot verbs run no command loop, so they pass nothing. */
	readonly commandHandler?: SupervisorCommandHandler;
	readonly beforeInitialAcquire?: (handle: SupervisorHandle) => Effect.Effect<void, HookE, HookR>;
	readonly withinScope?: (handle: SupervisorHandle) => Effect.Effect<void, HookE, HookR>;
	/** Caller plugin-context extension layered AFTER the built-in
	 *  (`extendBuiltInPluginContext`). Only the programmatic seam uses it (to
	 *  honor the public `runStack({ extendContext })`); the CLI verbs omit it
	 *  and get the built-in extension alone. */
	readonly extendContextAfterBuiltIn?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, ExtendR>;
}

/**
 * THE single site that assembles the production supervised body. It builds
 * the contribution dispatcher + post-acquire hook + built-in plugin-context
 * extension ONCE and hands them to {@link superviseStackEffect}, then
 * provides {@link layerBuiltInPluginRuntime}. Before this helper, the same
 * three-piece assembly was hand-rolled in three call sites
 * (`api/run-stack-internal.ts`, `cli/wirings/apply.ts`,
 * `cli/wirings/snapshot.ts`); now they all route through here and only
 * supply what genuinely differs ({@link ProductionBootOptions}).
 *
 * Each caller keeps its OWN lifetime-specific wrapping: the programmatic
 * seam wraps the returned effect in a `forkDetach` handle (long-running);
 * the CLI verbs run it to completion with their existing teardown + result
 * semantics (one-shot). This helper does NOT collapse those — it only
 * dedups the assembly the `superviseStackEffect` call sites shared.
 *
 * The return type is inferred (like `superviseStackEffect`): its R-channel
 * is the union of every substrate/orchestrator service the dispatcher /
 * hook / extension read, MINUS the built-in registries `layerBuiltInPluginRuntime`
 * supplies, PLUS the caller hook `HookR` / extend `ExtendR` channels.
 */
export const superviseStackWithProductionBoot = <
	HookR = Scope.Scope,
	HookE = never,
	ExtendR = never,
>(
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<import('../substrate/projection.ts').SubscribableState>,
	opts: ProductionBootOptions<HookR, HookE, ExtendR> = {},
) =>
	Effect.gen(function* () {
		const contributionDispatcher = yield* buildProductionContributionDispatcher();
		const postAcquireHook = yield* buildProductionPostAcquireHook({
			...(opts.extras === undefined ? {} : { extras: opts.extras }),
			...(opts.networkOptions === undefined ? {} : { networkOptions: opts.networkOptions }),
		});
		yield* superviseStackEffect(stack, identity, state, {
			contributionDispatcher,
			postAcquireHook,
			...(opts.lifetime === undefined ? {} : { lifetime: opts.lifetime }),
			...(opts.devstackVersion === undefined ? {} : { devstackVersion: opts.devstackVersion }),
			...(opts.commandHandler === undefined ? {} : { commandHandler: opts.commandHandler }),
			...(opts.beforeInitialAcquire === undefined
				? {}
				: { beforeInitialAcquire: opts.beforeInitialAcquire }),
			...(opts.withinScope === undefined ? {} : { withinScope: opts.withinScope }),
			// Built-in plugin-context extension ALWAYS runs; a caller extension
			// (the programmatic seam's `opts.extendContext`) chains AFTER it.
			extendContext: (ctx) =>
				Effect.gen(function* () {
					const builtInContext = yield* extendBuiltInPluginContext(ctx);
					return opts.extendContextAfterBuiltIn === undefined
						? builtInContext
						: yield* opts.extendContextAfterBuiltIn(builtInContext);
				}),
		}).pipe(Effect.provide(layerBuiltInPluginRuntime));
	});
