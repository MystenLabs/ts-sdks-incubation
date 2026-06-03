// `runStack(stack, opts?)` — top-level programmatic embedding.
//
// `defineDevstack(...)` returns a static `Stack<Members>` manifest with
// no runnable surface. Library consumers (vitest setup, custom hosts,
// Effect-native apps, embedded fixtures) would otherwise have to
// re-implement `cli/wirings/up.ts:runUpLive`'s substrate Layer composition.
// `runStack` is the single embedder seam — it consumes the same
// `orchestrators/runtime-composition.ts` helper the CLI consumes. See
// ARCHITECTURE.md §"Layer composition lives at L3, not L0".
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
import { makeProjectionRefSync } from '../substrate/runtime/index.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../orchestrators/run.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	layerProductionOrchestrators,
	type ProductionCodegenOptions,
} from '../orchestrators/runtime-composition.ts';
import { resolveCodegenOutput } from '../orchestrators/codegen/output-location.ts';
import {
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
} from '../orchestrators/built-in-plugin-layers.ts';
import { readStackEngine, type Stack } from './define-devstack.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';
import {
	resolveAppName,
	resolveNetworkSync,
	resolveStackName,
	resolveStateDir,
} from './inference-network.ts';

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
	 *  Precedence: `runtimeRoot` > `stateDir` (this option or
	 *  `DevstackOptions.stateDir` on the stack) > `$DEVSTACK_STATE_DIR`
	 *  > `<cwd>/.devstack`. */
	readonly runtimeRoot?: string;
	/** Sibling of `runtimeRoot` — the `DevstackOptions.stateDir` field
	 *  threaded through `runStack` so a stack-level default can be
	 *  overridden per-embedding without forcing every call site to
	 *  flip between `runtimeRoot` and `stateDir`. Same semantics as
	 *  `runtimeRoot`; lower precedence. */
	readonly stateDir?: string;
	/** Extend the plugin execution context after built-in plugin
	 *  services are installed. Use this for custom plugin-author
	 *  services or logger overrides. */
	readonly extendContext?: (
		ctx: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>, never, Scope.Scope>;
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
	/** Resolve when the supervisor fiber exits. Succeeds on a clean
	 *  shutdown; fails with the captured `Cause` if the supervisor died
	 *  mid-run after boot completed (e.g. a plugin scope finalizer
	 *  defect). Boot-time failures still surface via `start`. */
	readonly awaitShutdown: Effect.Effect<void, unknown, never>;
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
	// Parse + validate up-front so a malformed value fails here rather
	// than downstream when a plugin probes the chain id. We keep the
	// raw input string (`'sui:local'`, `'sui:testnet'`, …) for the
	// chain-id brand so existing on-disk cache namespaces and plugin
	// equality checks (`chain === 'sui:testnet'`) remain stable.
	const resolved = resolveNetworkSync({
		explicit: opts?.network,
		env: process.env.DEVSTACK_NETWORK,
		explicitSource: 'runStack({ identity.network })',
	});
	return {
		app: appName(app),
		stack: stackName(stackNameStr),
		chain: chainId(resolved.raw),
	};
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
	const runtimeRoot = resolveStateDir({
		runtimeRoot: opts.runtimeRoot,
		stateDir: opts.stateDir ?? engineStack.options.stateDir,
		env: process.env.DEVSTACK_STATE_DIR,
		cwd: process.cwd(),
	});
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
	// `Deferred.make` is sync-effect (no side-effects, no async);
	// `Effect.runSync` is safe for it. The projection ref is allocated
	// via the explicit `makeProjectionRefSync` so the sync contract is
	// pinned at the substrate constructor — if `makeProjectionRef`
	// ever picks up an async/Layer wrapper (`withSpan`, annotation),
	// `makeProjectionRefSync` must remain sync-only or be replaced by
	// a Deferred-handoff seam at this boot-time call site.
	const state = makeProjectionRefSync();
	const bootDeferred = Effect.runSync(Deferred.make<void, BootError>());
	const stopRequested = Effect.runSync(Deferred.make<void>());
	const eventQueueRef = Effect.runSync(Deferred.make<Queue.Dequeue<EngineEvent>>());
	const fiberRef = Effect.runSync(Deferred.make<Fiber.Fiber<void, never>>());
	const startClaim = Effect.runSync(Ref.make(false));
	// Tee for mid-run defects/failures. `Deferred.fail(bootDeferred, …)`
	// below is a no-op once `bootDeferred` has succeeded (post-boot), so
	// without this sibling ref a late scope-finalizer defect would
	// otherwise leave the supervised fiber exiting `Success(void)` and
	// `awaitShutdown` resolving clean — the operator would have no
	// signal. `awaitShutdown` re-raises whatever this ref captured.
	const midRunCauseRef = Effect.runSync(Ref.make<Cause.Cause<unknown> | null>(null));

	// Resolve the per-stack codegen output location: primary run (effective
	// stack === config `stackName`) → `src/generated/`; a secondary
	// embedding → `.devstack/stacks/<stack>/generated/`. An explicit
	// `opts.codegen.outputDir` (or the stack's own
	// `codegen.outputDir`) is honored verbatim by the resolver. Both the
	// primary stack (`engineStack.options.stackName`) and the effective
	// stack (the resolved `identity.stack`) are in scope here, mirroring
	// the CLI's `buildVerbLayers` seam.
	const codegenOutput = resolveCodegenOutput({
		appRoot,
		effectiveStack: String(identity.stack),
		primaryStack: engineStack.options.stackName,
		explicitOutputDir: codegen?.outputDir,
		explicitStackSubdir: codegen?.stackSubdir ?? null,
	});
	const substrate = layerProductionOrchestrators({
		codegen: {
			appRoot,
			outputDir: codegenOutput.outputDir,
			stackSubdir: codegenOutput.stackSubdir,
			extrasDir: codegenOutput.extrasDir,
		},
	}).pipe(Layer.provideMerge(buildSubstrateLayers(identity, runtimeRoot)));

	const supervised = Effect.gen(function* () {
		const contributionDispatcher = yield* buildProductionContributionDispatcher();
		const postAcquireHook = yield* buildProductionPostAcquireHook({ extras: stack.options.extras });
		yield* superviseStackEffect(supervisedStack, identity, state, {
			contributionDispatcher,
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
		}).pipe(Effect.provide(layerBuiltInPluginRuntime));
	});

	const loggerLayer = Logger.layer([]);
	const layered = supervised.pipe(Effect.provide(substrate), Effect.provide(loggerLayer));

	// Convert any uncaught cause into a boot failure if the deferred
	// hasn't completed. If `bootDeferred` HAS already succeeded then
	// `Deferred.fail` is a no-op — the cause is a mid-run failure
	// (e.g. a plugin scope finalizer defect) and would otherwise be
	// silently dropped: the fiber exits `Success(void)` and
	// `awaitShutdown` resolves clean. Tee the cause into
	// `midRunCauseRef` so `awaitShutdown` can re-surface it, AND emit
	// `Effect.logError(Cause.pretty(cause))` so observability stays
	// loud regardless of whether anyone awaits. Boot failures (still in
	// the bootDeferred-pending window) only surface via `start`, not
	// here — we'd otherwise re-raise them on `awaitShutdown` after
	// `start` already rejected.
	const supervisedProgram: Effect.Effect<void, never, never> = layered.pipe(
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				const bootAlreadyCompleted = yield* Deferred.isDone(bootDeferred);
				yield* Deferred.fail(bootDeferred, toBootError(cause)).pipe(
					Effect.asVoid,
					Effect.catch(() => Effect.void),
				);
				if (bootAlreadyCompleted) {
					yield* Ref.set(midRunCauseRef, cause);
				}
				yield* Effect.logError(`devstack runStack: supervisor died\n${Cause.pretty(cause)}`);
			}),
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

	const awaitShutdown: Effect.Effect<void, unknown, never> = Effect.gen(function* () {
		const alreadyStarted = yield* Deferred.isDone(fiberRef);
		if (!alreadyStarted) {
			return;
		}
		const fiber = yield* Deferred.await(fiberRef);
		yield* Fiber.await(fiber);
		// Re-surface any mid-run defect/failure captured by the
		// supervised body's `catchCause` (boot failures are already
		// surfaced via `start`). Without this re-raise a plugin scope
		// finalizer defect would silently drop and operators get no
		// signal — see the comment on `midRunCauseRef` above.
		const midRunCause = yield* Ref.get(midRunCauseRef);
		if (midRunCause !== null) {
			return yield* Effect.failCause(midRunCause);
		}
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
