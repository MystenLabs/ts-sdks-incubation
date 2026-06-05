// `runStackWithBoot(stack, optsWithBoot)` — the NON-PUBLIC seam under
// `runStack`.
//
// `api/run-stack.ts` is the thin PUBLIC facade: `runStack` delegates here
// with a zero-`boot` bag, so the public surface (`RunHandle`,
// `RunStackOptions`, `BootError`) and the zero-`boot` path stay
// byte-identical. This module owns the supervised-body construction and
// the caller-injectable boot hook seam the CLI `up` verb routes through in
// a later step (S3).
//
// Why a seam at all: `cli/wirings/up.ts:runUpLive` re-implements the SAME
// substrate Layer composition + supervised body `runStack` already builds,
// only to wrap it with extra `beforeInitialAcquire`/`withinScope` work
// (interrupted-restore recovery, warm capture/restore, the roster lock, the
// command-channel IPC bridge, the TUI surface). `runStackWithBoot` threads
// those as CALLER-INJECTED hooks so the CLI consumes one boot core instead
// of forking it. Because the bag is non-public, its hooks receive an
// `InternalRunHandle` that additionally carries the live `SupervisorHandle`
// (the seam the CLI hooks drain) — substrate detail that NEVER reaches the
// public `RunHandle`.
//
// PR#21 boot-ordering invariant (do not reorder): the composed hooks run
// the BUILT-IN work FIRST, then the caller's. For `beforeInitialAcquire`
// this means the event-queue handoff + stop-bridge + command-pump are armed
// before any caller hook runs (so a `stop()` during a caller hook always
// has a bridge) AND before the first acquire (`superviseStackEffect` runs
// the whole composed `beforeInitialAcquire` ahead of `runInitialAcquire`).
// For `withinScope` the built-in readiness-gate resolution (the S1 status
// scan that resolves `bootDeferred`) runs first, so a caller `withinScope`
// (e.g. warm-capture) can never delay `handle.start`.

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Queue,
	Ref,
	Stream,
} from 'effect';

import { appName, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../substrate/events.ts';
import { makeProjectionRefSync } from '../substrate/runtime/index.ts';
import type {
	SupervisorCommandHandler,
	SupervisorHandle,
} from '../substrate/runtime/supervisor/index.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	buildSubstrateLayers,
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
	layerProductionOrchestrators,
	resolveProductionCodegenOptions,
	superviseStackEffect,
} from '../orchestrators/boot.ts';
import { readStackEngine, type Stack } from './define-devstack.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';
import {
	resolveAppName,
	resolveNetworkSync,
	resolveStackName,
	resolveStateDir,
} from './inference-network.ts';
import type {
	BootError,
	RunHandle,
	RunStackIdentityOptions,
	RunStackOptions,
} from './run-stack.ts';

// -----------------------------------------------------------------------------
// Internal handle + boot bag
// -----------------------------------------------------------------------------

/** The handle the caller-injected `boot` hooks receive. It is the public
 *  `RunHandle` PLUS the live `SupervisorHandle` — the substrate seam the
 *  CLI `up` hooks drain (roster lock keys off it, the IPC bridge tails
 *  `supervisor.events` / pumps `supervisor.commands`, the TUI mounts
 *  `supervisor.state`). NON-PUBLIC: `index.ts` never re-exports it, so the
 *  `SupervisorHandle` substrate type stays off the public surface. */
export interface InternalRunHandle extends RunHandle {
	/** The live supervisor handle for this boot. Available inside both
	 *  composed hooks; carries `events`/`commands`/`runCommand`/`state`/
	 *  `graph`/`registry` the CLI hooks consume directly. */
	readonly supervisor: SupervisorHandle;
}

/** Caller-injected boot hooks. Both run AFTER their built-in counterpart
 *  (see the PR#21 ordering note at the top of this file). Their failures
 *  fold into `BootError.cause` via the same `catchCause` tee the built-in
 *  work uses, so `handle.start` stays `Effect<void, BootError, never>` —
 *  the bag does NOT widen the public error channel. */
export interface RunStackBootBag {
	readonly beforeInitialAcquire?: (
		handle: InternalRunHandle,
	) => Effect.Effect<void, unknown, never>;
	readonly withinScope?: (handle: InternalRunHandle) => Effect.Effect<void, unknown, never>;
}

/** `RunStackOptions` plus the non-public injection points. `commandHandler`
 *  threads straight into `superviseStackEffect`'s existing slot; `boot`
 *  carries the caller-injected hooks. */
export interface RunStackOptionsWithBoot extends RunStackOptions {
	readonly commandHandler?: SupervisorCommandHandler;
	readonly boot?: RunStackBootBag;
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
		chain: resolved.raw,
	};
};

const toBootError = (cause: Cause.Cause<unknown>): BootError => ({
	_tag: 'BootError',
	cause,
});

// -----------------------------------------------------------------------------
// runStackWithBoot
// -----------------------------------------------------------------------------

/**
 * The implementation behind `runStack`. Boots a `Stack` for programmatic
 * embedding and returns a `RunHandle` synchronously; the supervisor fiber
 * is forked on `start`.
 *
 * Lifecycle (identical to `runStack`'s documented contract):
 *
 *   1. `runStackWithBoot(stack, opts)` — synchronous; no fiber forked yet.
 *   2. `await Effect.runPromise(handle.start)` — forks the supervisor,
 *      blocks until every plugin reaches `ready` (or fails with
 *      `BootError`).
 *   3. Use `handle.events` / `handle.state` to observe.
 *   4. `await Effect.runPromise(handle.stop)` — graceful shutdown.
 *   5. `handle.awaitShutdown` resolves once finalizers complete.
 *
 * Internal architecture: the handle stores a `Deferred` for boot
 * completion. The supervised body resolves it from the SUPERVISOR-OWNED
 * readiness signal — `superviseStackEffect`'s `withinScope` hook fires
 * only after `runInitialAcquire` wins its `raceFirst` against
 * `awaitShutdown` (i.e. once `allReadyOrTerminal` — `ready || done` — is
 * true). This is the same `done`-tolerant gate the long-running CLI path
 * uses; it does NOT watch per-node ready-gates (a non-failed terminal
 * `done` node need never resolve its `awaitReady` gate). Initial-acquire
 * failures surface through the supervised body's `catchCause` tee, which
 * fails the deferred with a `BootError`. `start` awaits it.
 *
 * `opts.commandHandler` threads straight into `superviseStackEffect`'s
 * `commandHandler` slot. `opts.boot` injects caller hooks that run AFTER
 * their built-in counterpart (the PR#21 ordering); their failures fold
 * into `BootError` via the same `catchCause` tee, so `start` keeps its
 * `Effect<void, BootError, never>` type.
 */
export const runStackWithBoot = (
	stack: Stack<ReadonlyArray<AnyPlugin>>,
	opts: RunStackOptionsWithBoot = {},
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

	// State + handle slots are created at `runStackWithBoot(...)` time so
	// the caller can subscribe to `state.changes` BEFORE `start` runs.
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
	// Public command channel. Allocated eagerly (like `state`) so the
	// handle exposes a real `Queue.Enqueue<EngineCommand>` synchronously,
	// before `start`. Everything offered here is pumped onto the
	// supervisor's own command queue once it boots (see the pump in
	// `beforeInitialAcquire`), so a publish always lands on the seam the
	// supervisor drains — the TUI/IPC publish target.
	const commandQueue = Effect.runSync(Queue.unbounded<EngineCommand>());
	// `runCommand` is the supervisor's submit-and-await dispatch; only
	// knowable once `startSupervisor` runs. Surfaced via a Deferred the
	// same way `eventQueueRef` is. The IPC ack-correlation layers on top
	// of this later.
	const runCommandRef = Effect.runSync(
		Deferred.make<(command: EngineCommand) => Effect.Effect<void, unknown, never>>(),
	);
	const fiberRef = Effect.runSync(Deferred.make<Fiber.Fiber<void, never>>());
	const startClaim = Effect.runSync(Ref.make(false));
	// Tee for mid-run defects/failures. `Deferred.fail(bootDeferred, …)`
	// below is a no-op once `bootDeferred` has succeeded (post-boot), so
	// without this sibling ref a late scope-finalizer defect would
	// otherwise leave the supervised fiber exiting `Success(void)` and
	// `awaitShutdown` resolving clean — the operator would have no
	// signal. `awaitShutdown` re-raises whatever this ref captured.
	const midRunCauseRef = Effect.runSync(Ref.make<Cause.Cause<unknown> | null>(null));

	// Resolve the per-stack codegen output location through the ONE shared
	// boot seam: primary run (effective stack === config `stackName`) →
	// `src/generated/`; a secondary embedding →
	// `.devstack/stacks/<stack>/generated/`. An explicit `opts.codegen`
	// (or the stack's own `codegen`) is honored verbatim by the resolver.
	// Both the primary stack (`engineStack.options.stackName`) and the
	// effective stack (the resolved `identity.stack`) are in scope here,
	// exactly as in the CLI's `buildVerbLayers` seam — both now route
	// through `resolveProductionCodegenOptions`.
	const substrate = layerProductionOrchestrators({
		codegen: resolveProductionCodegenOptions({
			appRoot,
			effectiveStack: String(identity.stack),
			primaryStack: engineStack.options.stackName,
			codegen,
		}),
	}).pipe(Layer.provideMerge(buildSubstrateLayers(identity, runtimeRoot)));

	// The submit-and-await dispatch surfaced on the public handle. Awaits
	// the supervisor's `runCommand` (wired in the built-in
	// `beforeInitialAcquire`), then delegates.
	const runCommand = (command: EngineCommand): Effect.Effect<void, unknown, never> =>
		Effect.flatMap(Deferred.await(runCommandRef), (dispatch) => dispatch(command));

	const events: Stream.Stream<EngineEvent, never, never> = Stream.unwrap(
		Effect.gen(function* () {
			const queue = yield* Deferred.await(eventQueueRef);
			return Stream.fromQueue(queue);
		}),
	);

	// The PUBLIC handle is assigned exactly once at the end of this body
	// (after the lifecycle effects exist) and returned. The composed boot
	// hooks below close over `publicHandle` to build an `InternalRunHandle`
	// (the public handle + the live `SupervisorHandle`), but they only
	// deref it at BOOT time — long after this synchronous body finishes and
	// assigns it — so the closure is sound. Declared with a forward `let`
	// rather than mutated readonly fields so `RunHandle` stays immutable.
	let publicHandle: RunHandle;

	const supervised = Effect.gen(function* () {
		const contributionDispatcher = yield* buildProductionContributionDispatcher();
		const postAcquireHook = yield* buildProductionPostAcquireHook({
			extras: stack.options.extras,
		});
		yield* superviseStackEffect(supervisedStack, identity, state, {
			contributionDispatcher,
			commandHandler: opts.commandHandler,
			postAcquireHook,
			extendContext: (ctx) =>
				Effect.gen(function* () {
					const builtInContext = yield* extendBuiltInPluginContext(ctx);
					return opts.extendContext === undefined
						? builtInContext
						: yield* opts.extendContext(builtInContext);
				}),
			// ── COMPOSED `beforeInitialAcquire` (ONE ordered gen) ──────────
			// ORDER (PR#21-load-bearing): BUILT-IN work first, THEN caller.
			//   1. built-in: event-queue handoff + runCommand surface +
			//      command-pump fork + stop-bridge fork.
			//   2. caller: `opts.boot?.beforeInitialAcquire(internalHandle)`.
			// `superviseStackEffect` runs this whole composed effect BEFORE
			// `runInitialAcquire`, so the caller hook (recover/warm/roster/
			// IPC/TUI in S3) runs before first acquire too; and because the
			// built-in stop-bridge is armed first, a `stop()` raised during a
			// caller hook always has a command bridge.
			beforeInitialAcquire: (handle) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(eventQueueRef, handle.events).pipe(
						Effect.catch(() => Effect.void),
					);
					// Surface the supervisor's submit-and-await dispatch onto the
					// public handle BEFORE acquire so a boot failure can't leave
					// the handle without a command bridge.
					yield* Deferred.succeed(runCommandRef, handle.runCommand).pipe(
						Effect.catch(() => Effect.void),
					);
					// Pump the eager public command queue onto the supervisor's
					// own command queue (`handle.commands` — the seam the signal
					// handler + command loop drain). A publish on the public
					// queue therefore always reaches the supervisor's drain.
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							while (true) {
								const command = yield* Queue.take(commandQueue);
								yield* Queue.offer(handle.commands, command);
							}
						}),
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

					// Caller-injected work runs AFTER the built-in bridges are
					// armed. Its failures fold into the supervised body's
					// `catchCause` below (and thence into `BootError`).
					if (opts.boot?.beforeInitialAcquire !== undefined) {
						const internalHandle: InternalRunHandle = {
							...publicHandle,
							supervisor: handle,
						};
						yield* opts.boot.beforeInitialAcquire(internalHandle);
					}
				}),
			// ── COMPOSED `withinScope` (ONE ordered gen) ───────────────────
			// ORDER: BUILT-IN readiness-gate resolution first, THEN caller.
			//   1. built-in: the S1 status scan that resolves `bootDeferred`.
			//   2. caller: `opts.boot?.withinScope(internalHandle)`.
			// Resolving the gate first means a caller `withinScope` (e.g.
			// warm-capture) can never delay `handle.start`.
			withinScope: (handle) =>
				// Resolve the boot gate from the SUPERVISOR-OWNED readiness
				// signal. `superviseStackEffect` only calls `withinScope`
				// after `runInitialAcquire` wins its `raceFirst` against
				// `awaitShutdown` and yields `'booted'` (boot.ts) — i.e. once
				// `allReadyOrTerminal` is true (`ready || done`). This is the
				// SAME `done`-tolerant gate the long-running CLI path uses,
				// not a per-node `awaitReady` watcher (whose ready-gate a
				// non-failed terminal `done` node need never resolve, so it
				// would hang here).
				//
				// `runInitialAcquire` does NOT itself fail on a per-PLUGIN
				// acquire failure: `acquireFullGraph` swallows node failures
				// into the registry's `failed` status (the CLI surfaces them as
				// red TUI rows and keeps the stack up). runStack's contract is
				// stricter — `start` FAILS with `BootError` if any node failed
				// initial acquire. So gate on the STATUS contract here: succeed
				// iff every node is `ready`/`done`, else fail with the first
				// `failed` node's `PluginAcquireFailed` cause. A failed node's
				// ready-gate IS resolved (markFailed failed it), so reading it
				// is hang-free — the `done`-tolerant equivalent of the old
				// watcher's failure detection. (Post-acquire HOOK failures —
				// codegen / manifest — fail `runInitialAcquire` directly and
				// tee through the supervised body's `catchCause` below; we
				// never reach here on that path.)
				Effect.gen(function* () {
					let firstFailure: BootError | null = null;
					for (const [key] of handle.graph.nodes) {
						const status = yield* handle.registry
							.getStatus(key)
							.pipe(Effect.catch(() => Effect.succeed('failed' as const)));
						if (status === 'failed') {
							const failureExit = yield* Effect.exit(handle.registry.awaitReady(key));
							firstFailure = toBootError(
								Exit.isFailure(failureExit) ? failureExit.cause : Cause.empty,
							);
							break;
						}
					}
					if (firstFailure === null) {
						yield* Deferred.succeed(bootDeferred, undefined).pipe(Effect.asVoid);
					} else {
						yield* Deferred.fail(bootDeferred, firstFailure).pipe(Effect.asVoid);
					}

					// Caller-injected work runs AFTER the boot gate is resolved,
					// so it can never delay `handle.start`. Its failures fold
					// into the supervised body's `catchCause` below; since the
					// boot gate already succeeded by this point, such a failure
					// surfaces on `awaitShutdown` (mid-run), not `start` — the
					// same place a built-in `withinScope` failure would land.
					if (opts.boot?.withinScope !== undefined) {
						const internalHandle: InternalRunHandle = {
							...publicHandle,
							supervisor: handle,
						};
						yield* opts.boot.withinScope(internalHandle);
					}
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
	// `start` already rejected. NOTE: a CALLER `boot` hook failure folds
	// through this SAME tee, so its failure surfaces as `BootError` on
	// `start` (when raised before the gate resolves) or re-raises on
	// `awaitShutdown` (after) — never widening `start`'s error channel.
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
				// `forkDetach` decouples the supervisor fiber from the `start`
				// fiber's scope. `forkChild`
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

	// Assign the handle the composed boot hooks close over (they only deref
	// it at boot, after this assignment) and return it.
	publicHandle = {
		start,
		stop,
		awaitShutdown,
		events,
		state,
		commands: commandQueue,
		runCommand,
		identity,
	};

	return publicHandle;
};
