// `runStack(stack, opts?)` — top-level programmatic embedding.
//
// Cutover blocker #3 (api-surface-design.md § Stack handle, parity-
// matrix.md "Programmatic embedding"): `defineDevstack(...)` returns a
// static `Stack<Members>` manifest with no runnable surface. Library
// consumers (vitest setup, custom hosts, Effect-native apps, embedded
// fixtures) had to re-implement `cli/main.ts:runUpLive`'s substrate
// Layer composition. `runStack` is the single seam — it consumes the
// shared `orchestrators/run.ts` helper the CLI also consumes.
//
// Shape:
//
// ```ts
// const stack = defineDevstack(...);
// const handle = runStack(stack, { runtimeRoot: '/tmp/devstack' });
// await Effect.runPromise(handle.start);
// // ... interact ...
// await Effect.runPromise(handle.stop);
// await Effect.runPromise(handle.awaitShutdown);
// ```
//
// `start` resolves when every plugin has reached `ready` (or when one
// fails to acquire — `start` then fails with `BootError`). `stop`
// triggers graceful shutdown; `awaitShutdown` resolves when the fiber
// finishes its scope finalizers.

import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Queue,
	Ref,
	Scope,
	Stream,
	SubscriptionRef,
} from 'effect';

import { appName, chainId, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import { CapabilitySinksService } from '../substrate/runtime/capability-sinks/index.ts';
import { makeProjectionRef } from '../substrate/runtime/projection/index.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../orchestrators/run.ts';
import {
	buildProductionOrchestratorSinks,
	buildProductionPostAcquireHook,
	layerProductionOrchestrators,
	type ProductionCodegenOptions,
} from '../orchestrators/runtime-composition.ts';
import {
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
} from '../runtime/built-in-plugin-layers.ts';
import { readStackEngine, type Stack } from './define-devstack.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';
import { resolveAppName, resolveStackName } from './inference-network.ts';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Identity overrides for `runStack`. App and stack fall back through
 *  shared package metadata inference after their env overrides. */
export interface RunStackIdentityOptions {
	readonly app?: string;
	readonly stack?: string;
	readonly network?: string;
}

export interface RunStackOptions {
	/** Identity overrides — falls back to env + library defaults. */
	readonly identity?: RunStackIdentityOptions;
	/** User application root. Codegen defaults to `<appRoot>/src/generated`.
	 *  Defaults to `process.cwd()`. */
	readonly appRoot?: string;
	/** Codegen output overrides for embedded tests or custom app layout. */
	readonly codegen?: Omit<ProductionCodegenOptions, 'appRoot'>;
	/** Filesystem root under which the substrate stores per-stack
	 *  artifacts (cache, snapshots, manifest, projection, etc.).
	 *  Defaults to `$DEVSTACK_STATE_DIR` then `<cwd>/.devstack`. */
	readonly runtimeRoot?: string;
	/** Extend the plugin execution context after built-in plugin
	 *  services are installed. Use this for custom plugin-author
	 *  services, capability sinks, or logger overrides. */
	readonly extendContext?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, Scope.Scope | CapabilitySinksService>;
}

/** Boot error surfaced by `RunHandle.start`. Wraps the supervisor's
 *  startup failure tree for cascade-formatter rendering. */
export interface BootError {
	readonly _tag: 'BootError';
	readonly cause: Cause.Cause<unknown>;
}

/** Programmatic handle. Symmetric with the attached CLI surface:
 *  `events`, `state`, and `awaitShutdown` are the same primitives the
 *  TUI consumes in-process. */
export interface RunHandle {
	/** Boot the supervisor and resolve when every plugin reaches
	 *  `ready`. Fails with `BootError` if any plugin's acquire path
	 *  fails. */
	readonly start: Effect.Effect<void, BootError, never>;
	/** Trigger graceful shutdown: enqueues `shutdown.requested` onto
	 *  the supervisor's command channel, then awaits the fiber. */
	readonly stop: Effect.Effect<void, never, never>;
	/** Resolve when the supervisor fiber exits. Always succeeds — any
	 *  errors surface via `start`. */
	readonly awaitShutdown: Effect.Effect<void, never, never>;
	/** Tail of typed engine events from the supervisor's hub. The
	 *  upstream is a `Queue.Dequeue`; consume via `Stream.run...`. */
	readonly events: Stream.Stream<EngineEvent, never, never>;
	/** The supervisor's live projection. Renderers + tests read this
	 *  directly; changes flow through `SubscriptionRef.changes`. */
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
}

// -----------------------------------------------------------------------------
// Identity resolution
// -----------------------------------------------------------------------------

const resolveIdentity = (
	stack: Stack<ReadonlyArray<AnyPlugin>>,
	opts: RunStackIdentityOptions | undefined,
	cwd: string,
): Identity => {
	const app = resolveAppName({
		explicit: opts?.app,
		cwd,
	});
	const stackNameStr = resolveStackName({
		explicit: opts?.stack ?? stack.options.stackName,
		cwd,
	});
	const network = opts?.network ?? process.env.DEVSTACK_NETWORK ?? 'sui:local';
	return {
		app: appName(app),
		stack: stackName(stackNameStr),
		chain: chainId(network),
	};
};

const resolveRuntimeRoot = (override: string | undefined): string => {
	if (override !== undefined) return override;
	const envRoot = process.env.DEVSTACK_STATE_DIR;
	if (envRoot !== undefined && envRoot.length > 0) return envRoot;
	return `${process.cwd()}/.devstack`;
};

const toBootError = (cause: Cause.Cause<unknown>): BootError => ({
	_tag: 'BootError',
	cause,
});

// -----------------------------------------------------------------------------
// runStack
// -----------------------------------------------------------------------------

/**
 * Boot a `Stack` for programmatic embedding. Returns a `RunHandle`
 * synchronously; the supervisor fiber is forked on `start`.
 *
 * Lifecycle:
 *
 *   1. `runStack(stack, opts)` — synchronous; no fiber forked yet.
 *   2. `await Effect.runPromise(handle.start)` — forks the supervisor,
 *      blocks until every plugin reaches `ready` (or fails with
 *      `BootError`).
 *   3. Use `handle.events` / `handle.state` to observe.
 *   4. `await Effect.runPromise(handle.stop)` — graceful shutdown.
 *   5. `handle.awaitShutdown` resolves once finalizers complete.
 *
 * Internal architecture: the handle stores a `Deferred` for boot
 * completion. The supervised body forks a watcher fiber over the
 * registry's `awaitReady` per node; once every node is `ready` (or one
 * fails) the deferred completes. `start` awaits it.
 */
export const runStack = (
	stack: Stack<ReadonlyArray<AnyPlugin>>,
	opts: RunStackOptions = {},
): RunHandle => {
	const engineStack = readStackEngine(stack);
	const runtimeRoot = resolveRuntimeRoot(opts.runtimeRoot);
	const appRoot = opts.appRoot ?? process.cwd();
	const identity = resolveIdentity(stack, opts.identity, appRoot);
	const codegen = opts.codegen ?? engineStack.options.codegen;

	const supervisedStack = {
		_tag: 'Stack' as const,
		members: engineStack.members,
		options: engineStack.options,
	};

	// State + handle slots are created at `runStack(...)` time so the
	// caller can subscribe to `state.changes` BEFORE `start` runs.
	// `SubscriptionRef.make` and `Deferred.make` are both sync-effects
	// (no side-effects, no async); `Effect.runSync` is safe here.
	const state = Effect.runSync(makeProjectionRef());
	const bootDeferred = Effect.runSync(Deferred.make<void, BootError>());
	const stopRequested = Effect.runSync(Deferred.make<void>());
	const eventQueueRef = Effect.runSync(Deferred.make<Queue.Dequeue<EngineEvent>>());
	const fiberRef = Effect.runSync(Deferred.make<Fiber.Fiber<void, never>>());
	const startClaim = Effect.runSync(Ref.make(false));

	const substrate = layerProductionOrchestrators({
		codegen: {
			appRoot,
			outputDir: codegen?.outputDir,
			stackSubdir: codegen?.stackSubdir ?? null,
		},
	}).pipe(Layer.provideMerge(buildSubstrateLayers(identity, runtimeRoot)));

	const supervised = Effect.gen(function* () {
		const orchestratorSinks = yield* buildProductionOrchestratorSinks();
		const postAcquireHook = yield* buildProductionPostAcquireHook({ extras: stack.options.extras });
		yield* superviseStackEffect(supervisedStack, identity, state, {
			orchestratorSinks,
			postAcquireHook,
			extendContext: (ctx) =>
				Effect.gen(function* () {
					const builtInContext = yield* extendBuiltInPluginContext(ctx);
					return opts.extendContext === undefined
						? builtInContext
						: yield* opts.extendContext(builtInContext);
				}),
			beforeInitialAcquire: (handle) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(eventQueueRef, handle.events).pipe(
						Effect.catch(() => Effect.void),
					);

					// Bridge `stop` requests onto the supervisor's command
					// channel before acquire starts so a boot failure cannot
					// leave the public handle without an event/command bridge.
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							yield* Deferred.await(stopRequested);
							yield* Queue.offer(handle.commands, {
								tag: 'shutdown.requested',
							});
						}),
					);
				}),
			withinScope: (handle) =>
				Effect.gen(function* () {
					// Watch every plugin for `ready`; resolve `bootDeferred` once
					// every node has reached ready (or one fails). The
					// `awaitReady` callbacks resolve from the per-plugin
					// ready-gates the registry holds — see supervisor §
					// "ready-gate awaits its acquire effect".
					// Both forks tie to the surrounding scope (the supervised
					// scope inside superviseStackEffect). When the supervisor
					// scope closes — either via graceful shutdown or interrupt
					// — these fibers are torn down with it.
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							const exits = yield* Effect.forEach(
								handle.graph.nodes,
								([key]) => handle.registry.awaitReady(key).pipe(Effect.exit),
								{ concurrency: 'unbounded' },
							);
							const firstFailure = exits.find(Exit.isFailure);
							if (firstFailure === undefined) {
								yield* Deferred.succeed(bootDeferred, undefined);
							} else {
								yield* Deferred.fail(bootDeferred, toBootError(firstFailure.cause));
							}
						}),
					);
				}),
		}).pipe(Effect.provide(layerBuiltInPluginRuntime(orchestratorSinks)));
	});

	const loggerLayer = Logger.layer([]);
	const layered = supervised.pipe(Effect.provide(substrate), Effect.provide(loggerLayer));

	// Convert any uncaught cause into a boot failure if the deferred
	// hasn't completed. The cause is preserved via the fiber's exit for
	// `awaitShutdown` consumers that need to inspect it.
	const supervisedProgram: Effect.Effect<void, never, never> = layered.pipe(
		Effect.catchCause((cause) =>
			Deferred.fail(bootDeferred, toBootError(cause)).pipe(
				Effect.asVoid,
				Effect.catch(() => Effect.void),
			),
		),
	);

	const start: Effect.Effect<void, BootError, never> = Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const shouldStart = yield* Ref.modify(startClaim, (started) =>
				started ? [false, true] : [true, true],
			);
			if (shouldStart) {
				// `forkDetach` (v4 spelling of v3's `forkDaemon`) decouples the
				// supervisor fiber from the `start` fiber's scope. `forkChild`
				// would tie the supervisor to whatever fiber runs `start`, and
				// once `start` resolves (after `bootDeferred` succeeds) the
				// runtime would interrupt the supervisor — transitioning every
				// plugin `ready → stopping → stopped` before the caller can
				// read post-ready state or call `handle.stop`. The handle's
				// explicit `stop` + `awaitShutdown` paths are the only
				// shutdown signals; the captured `Fiber` reference is how the
				// daemon stays releasable.
				const fiber = yield* Effect.forkDetach(supervisedProgram);
				yield* Deferred.succeed(fiberRef, fiber);
			}
			yield* restore(Deferred.await(bootDeferred));
		}),
	);

	const stop: Effect.Effect<void, never, never> = Effect.gen(function* () {
		yield* Deferred.succeed(stopRequested, undefined).pipe(Effect.catch(() => Effect.void));
		const alreadyStarted = yield* Deferred.isDone(fiberRef);
		if (!alreadyStarted) {
			return;
		}
		const fiber = yield* Deferred.await(fiberRef);
		// `Fiber.await` returns an `Exit` without raising — handles both
		// success and interrupt-cause cases (the supervisor's
		// graceful-shutdown path closes the scope, which surfaces as an
		// interrupt cause if the fiber was mid-await on the latch poll).
		yield* Fiber.await(fiber);
	});

	const awaitShutdown: Effect.Effect<void, never, never> = Effect.gen(function* () {
		const alreadyStarted = yield* Deferred.isDone(fiberRef);
		if (!alreadyStarted) {
			return;
		}
		const fiber = yield* Deferred.await(fiberRef);
		yield* Fiber.await(fiber);
	});

	const events: Stream.Stream<EngineEvent, never, never> = Stream.unwrap(
		Effect.gen(function* () {
			const queue = yield* Deferred.await(eventQueueRef);
			return Stream.fromQueue(queue);
		}),
	);

	return {
		start,
		stop,
		awaitShutdown,
		events,
		state,
	};
};
