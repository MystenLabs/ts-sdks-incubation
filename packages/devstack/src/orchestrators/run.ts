// Default-stack Layer composition + supervise() entrypoint.
//
// Single seam consumed by both the CLI bin entry (`cli/main.ts`) and the
// library-facing programmatic surface (`api/run-stack.ts`). Composes the
// substrate Layer stack (L0) + the Docker `ContainerRuntime` adapter
// (L1), yields the substrate services into a `Context.Context<never>`
// pluginContext, builds the projection ref, and runs `supervise()`
// inside a scope.
//
// The CLI augments the supervised body with cross-process command
// channel forwarding; the library surface passes a no-op augmentation
// and exposes the handle's events / state / awaitShutdown directly.
//
// Architecture: this is L3 (orchestrator-level). Layer composition that
// assembles L0+L1 stacks belongs at L3/L4 — it can't live in `substrate/`
// because it imports a concrete L1 adapter (Docker) by definition. See
// ARCHITECTURE.md § "Layer composition belongs at L3/L4, not L0".

import { Context, Effect, Layer, Logger as EffectLogger, Scope, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { Identity } from '../substrate/identity.ts';
import { CacheService, layerCache } from '../substrate/runtime/cache/index.ts';
import { LeaseBrokerService, layerLeaseBroker } from '../substrate/runtime/lease-broker/index.ts';
import {
	ArtifactPublisherService,
	layerArtifactPublisher,
} from '../substrate/runtime/artifact-publisher/index.ts';
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
import { awaitAll } from '../substrate/runtime/lifecycle/index.ts';
import { makeProjectionRef } from '../substrate/runtime/projection/index.ts';
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
	const withArtifactPublisher = layerArtifactPublisher.pipe(Layer.provideMerge(withCache));
	const withPortBroker = layerPortBroker.pipe(Layer.provideMerge(withArtifactPublisher));
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
 *  may extend the context (e.g. layering a Logger or a
 *  `CapabilitySinksService`) before passing it to `supervise()`. */
const buildPluginContext = (): Effect.Effect<
	Context.Context<never>,
	never,
	| IdentityContext
	| RuntimeRoot
	| StackPathsService
	| CacheService
	| StrategyRegistryService
	| ContainerRuntimeService
	| ArtifactPublisherService
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
		const publisher = yield* ArtifactPublisherService;
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
			Context.add(ArtifactPublisherService, publisher),
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
	 *  the CLI when it wants to inject a custom Logger / CapabilitySinks
	 *  override. */
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
export interface RunStackEffectOptions<
	R = Scope.Scope,
	ExtendR = never,
	HookE = never,
> extends SuperviseStackOptions<R, ExtendR, HookE> {
	readonly runtimeRoot: string;
	readonly loggerLayer?: Layer.Layer<never>;
}

export const runStackEffect = <R = Scope.Scope, ExtendR = never, HookE = never>(
	stack: SupervisedStack,
	identity: Identity,
	opts: RunStackEffectOptions<R, ExtendR, HookE>,
) => {
	const substrate = buildSubstrateLayers(identity, opts.runtimeRoot);
	const program = Effect.gen(function* () {
		const state = yield* makeProjectionRef();
		yield* superviseStackEffect(stack, identity, state, opts);
	});

	return program.pipe(
		Effect.provide(substrate),
		Effect.provide(opts.loggerLayer ?? EffectLogger.layer([])),
	);
};
