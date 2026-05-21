// Shared substrate-Layer composition + supervise() entrypoint.
//
// Single seam consumed by both the CLI bin entry (`cli/main.ts`) and the
// library-facing programmatic surface (`api/run-stack.ts`). Composes the
// substrate Layer stack, yields the substrate services into a
// `Context.Context<never>` pluginContext, builds the projection ref,
// and runs `supervise()` inside a scope.
//
// The CLI augments the supervised body with cross-process command
// channel forwarding; the library surface passes a no-op augmentation
// and exposes the handle's events / state / awaitShutdown directly.
//
// Architecture: this is L0 substrate. It names no plugin and no
// capability decl — the only L2 names it touches are the wrapper
// `CoinRegistryService` / `PackageRegistryService` Layers (consumed by
// the supervisor's harvest loop and by built-in plugins that yield
// them from their `acquire` bodies). These two registry layers ride at
// the substrate boundary because the supervisor needs them in
// `pluginContext` regardless of whether the stack actually uses coin /
// package plugins (cf. STYLE_GUIDE §10b — L2 wrapper-service around
// `defineScopedRefMap`).

import { Context, Effect, Layer, Logger as EffectLogger, Scope, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { Identity } from '../identity.ts';
import { CacheService, layerCache } from './cache/index.ts';
import { LeaseBrokerService, layerLeaseBroker } from './lease-broker/index.ts';
import {
	OnChainArtifactPublisherService,
	layerOnChainArtifactPublisher,
} from './on-chain-artifact/index.ts';
import {
	IdentityContext,
	RuntimeRoot,
	StackPathsService,
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
} from './paths.ts';
import { PortBrokerService, layerPortBroker } from './port-broker/index.ts';
import { StrategyRegistryService, layerStrategyRegistry } from './strategy-registry/index.ts';
import { CoinRegistryService, coinRegistryLayer } from '../../plugins/coin/registry.ts';
import { PackageRegistryService, layerPackageRegistry } from '../../plugins/package/registry.ts';
import {
	ContainerRuntimeService,
	DockerSpawner,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
	layerDockerHostDefault,
} from '../../runtime/docker/index.ts';
import { makeProjectionRef } from './projection/index.ts';
import { Logger, layerLogger } from './observability/index.ts';
import {
	startSupervisor,
	type OrchestratorSinks,
	type SupervisedStack,
	type SupervisorCommandHandler,
	type SupervisorHandle,
	type SupervisorPostAcquireHook,
} from './supervisor.ts';

/** Substrate Layer stack for a single supervised run. Composes every L0
 *  service the supervisor + built-in plugins yield from their
 *  R-channels, plus the L1 Docker `ContainerRuntime`. The output is the
 *  full `R` requirement set for `supervise()`'s pluginContext build. */
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
	const withOca = layerOnChainArtifactPublisher.pipe(Layer.provideMerge(withCache));
	const withCoinRegistry = coinRegistryLayer.pipe(Layer.provideMerge(withOca));
	const withPackageRegistry = layerPackageRegistry.pipe(Layer.provideMerge(withCoinRegistry));
	const withPortBroker = layerPortBroker.pipe(Layer.provideMerge(withPackageRegistry));
	const withLeaseBroker = layerLeaseBroker.pipe(Layer.provideMerge(withPortBroker));
	const withSpawnerAdapter = layerDockerSpawnerFromNode.pipe(Layer.provideMerge(withLeaseBroker));
	const withContainerRuntime = layerContainerRuntimeDocker.pipe(
		Layer.provideMerge(withSpawnerAdapter),
	);
	return layerLogger.pipe(Layer.provideMerge(withContainerRuntime));
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
	| OnChainArtifactPublisherService
	| PackageRegistryService
	| CoinRegistryService
	| PortBrokerService
	| LeaseBrokerService
	| Logger
> =>
	Effect.gen(function* () {
		const identityCtx = yield* IdentityContext;
		const runtimeRootResolved = yield* RuntimeRoot;
		const stackPaths = yield* StackPathsService;
		const cache = yield* CacheService;
		const registry = yield* StrategyRegistryService;
		const containerRuntime = yield* ContainerRuntimeService;
		const publisher = yield* OnChainArtifactPublisherService;
		const packageRegistry = yield* PackageRegistryService;
		const coinRegistry = yield* CoinRegistryService;
		const portBroker = yield* PortBrokerService;
		const leaseBroker = yield* LeaseBrokerService;
		const logger = yield* Logger;

		return Context.empty().pipe(
			Context.add(IdentityContext, identityCtx),
			Context.add(RuntimeRoot, runtimeRootResolved),
			Context.add(StackPathsService, stackPaths),
			Context.add(CacheService, cache),
			Context.add(StrategyRegistryService, registry),
			Context.add(ContainerRuntimeService, containerRuntime),
			Context.add(OnChainArtifactPublisherService, publisher),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PortBrokerService, portBroker),
			Context.add(LeaseBrokerService, leaseBroker),
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
export interface SuperviseStackOptions<R = Scope.Scope> {
	readonly lifetime?: 'long-running' | 'one-shot';
	readonly beforeInitialAcquire?: (handle: SupervisorHandle) => Effect.Effect<void, never, R>;
	readonly withinScope?: (handle: SupervisorHandle) => Effect.Effect<void, never, R>;
	readonly commandHandler?: SupervisorCommandHandler;
	readonly orchestratorSinks?: OrchestratorSinks;
	readonly postAcquireHook?: SupervisorPostAcquireHook;
	/** Caller-supplied extension layered into `pluginContext` after the
	 *  default substrate context is built. Used by plugin-author Layer
	 *  composition (ARCHITECTURE.md § Plugin-author extension) and by
	 *  the CLI when it wants to inject a custom Logger / CapabilitySinks
	 *  override. */
	readonly extendContext?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, never>;
}

/** Effect that boots the supervisor for `stack` and blocks on the
 *  supervisor's shutdown latch. Returns the final `SubscribableState`
 *  snapshot so callers (CLI, library handle) can inspect post-shutdown
 *  state. */
export const superviseStackEffect = <R = Scope.Scope>(
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<import('../projection.ts').SubscribableState>,
	opts: SuperviseStackOptions<R> = {},
) =>
	Effect.gen(function* () {
		const baseContext = yield* buildPluginContext();
		const pluginContext =
			opts.extendContext === undefined ? baseContext : yield* opts.extendContext(baseContext);

		return yield* Effect.scoped(
			Effect.gen(function* () {
				const startup = yield* startSupervisor(
					stack,
					identity,
					state,
					pluginContext,
					opts.orchestratorSinks ?? {},
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
					if (opts.withinScope !== undefined) {
						yield* opts.withinScope(handle);
					}
					return;
				}
				const outcome = yield* Effect.race(
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
export interface RunStackEffectOptions extends SuperviseStackOptions {
	readonly runtimeRoot: string;
	readonly loggerLayer?: Layer.Layer<never>;
}

export const runStackEffect = (
	stack: SupervisedStack,
	identity: Identity,
	opts: RunStackEffectOptions,
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
