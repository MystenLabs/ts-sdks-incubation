// `runStackWithBoot(stack, optsWithBoot)` — the NON-PUBLIC seam under
// `runStack`.
//
// `api/run-stack.ts` is the thin PUBLIC facade: `runStack` delegates here
// with a zero-`boot` bag, so the public surface (`RunHandle`,
// `RunStackOptions`, `BootError`) and the zero-`boot` path stay
// byte-identical. This module owns the supervised-body construction and
// the caller-injectable boot hook seam the CLI `up` verb routes through.
//
// Why a seam at all: the CLI `up` verb needs the SAME substrate Layer
// composition + supervised body `runStack` builds, but wrapped with extra
// `beforeInitialAcquire`/`withinScope` work (interrupted-restore recovery,
// the roster lock, the command-channel IPC bridge, and the TUI surface).
// `runStackWithBoot` threads those as CALLER-INJECTED hooks so
// the CLI consumes ONE boot core instead of forking it. Because the bag is
// non-public, its hooks receive an `InternalRunHandle` that additionally
// carries the live `SupervisorHandle` (the seam the CLI hooks drain) —
// substrate detail that NEVER reaches the public `RunHandle`.
//
// PR#21 boot-ordering invariant (do not reorder): the composed hooks run
// the BUILT-IN work FIRST, then the caller's. For `beforeInitialAcquire`
// this means the event-queue handoff + stop-bridge + command-pump are armed
// before any caller hook runs (so a `stop()` during a caller hook always
// has a bridge) AND before the first acquire (`superviseStackEffect` runs
// the whole composed `beforeInitialAcquire` ahead of `runInitialAcquire`).
// For `withinScope` the built-in readiness-gate resolution (the status
// scan that resolves `bootDeferred`) runs first, so a caller `withinScope`
// can never delay `handle.start`.

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	type FileSystem,
	Layer,
	Logger,
	Queue,
	Ref,
	type Scope,
	Stream,
	type SubscriptionRef,
} from 'effect';

import { appName, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../substrate/events.ts';
import { makeProjectionRefSync } from '../substrate/runtime/index.ts';
import type { StackPathsService } from '../substrate/runtime/paths.ts';
import type { SnapshotOrchestratorService } from '../orchestrators/snapshot/index.ts';
import type {
	SupervisorCommandHandler,
	SupervisorHandle,
} from '../substrate/runtime/supervisor/index.ts';
import {
	buildSubstrateLayers,
	layerProductionOrchestrators,
	resolveProductionCodegenOptions,
	superviseStackWithProductionBoot,
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

/** The substrate services the seam already has in scope when it runs the
 *  caller hooks (the composed `beforeInitialAcquire`/`withinScope` run
 *  inside `superviseStackEffect`, which is `Effect.provide(substrate)`).
 *  The bag hooks may yield these directly — the CLI `up` hooks drive the
 *  ONE `SnapshotOrchestratorService` instance the supervisor's contribution
 *  dispatcher registers participants on (so an operator `snapshot save`
 *  captures the LIVE participant set, not an empty one off a sibling
 *  orchestrator), plus `FileSystem`/`StackPathsService` for the
 *  interrupted-restore + roster paths. `Scope.Scope` lets a hook fork
 *  scoped fibers (the IPC pump, the TUI mount) onto the supervised scope.
 *  NON-PUBLIC: like `InternalRunHandle`, this never reaches the public
 *  `runStack` facade. */
export type BootHookServices =
	| Scope.Scope
	| SnapshotOrchestratorService
	| FileSystem.FileSystem
	| StackPathsService;

/** Caller-injected boot hooks. Both run AFTER their built-in counterpart
 *  (see the PR#21 ordering note at the top of this file). Their failures
 *  fold into `BootError.cause` via the same `catchCause` tee the built-in
 *  work uses, so `handle.start` stays `Effect<void, BootError, never>` —
 *  the bag does NOT widen the public error channel. The R-channel is
 *  `BootHookServices` (substrate services the seam already provides), NOT
 *  `never`: the hooks run inside the supervised scope and may drive the
 *  seam's live substrate (notably the supervisor's snapshot orchestrator). */
export interface RunStackBootBag {
	readonly devstackVersion?: string;
	readonly beforeInitialAcquire?: (
		handle: InternalRunHandle,
	) => Effect.Effect<void, unknown, BootHookServices>;
	readonly withinScope?: (
		handle: InternalRunHandle,
	) => Effect.Effect<void, unknown, BootHookServices>;
}

/** The substrate services a {@link CommandHandlerFactory} may yield — the
 *  same singletons the contribution dispatcher + boot hooks see, minus
 *  `Scope.Scope` (the factory runs before the supervised scope opens, so it
 *  forks nothing). A handler closes over `SnapshotOrchestratorService` to
 *  capture the LIVE participant set and `FileSystem` to thread it into the
 *  snapshot I/O. */
type CommandHandlerServices =
	| SnapshotOrchestratorService
	| FileSystem.FileSystem
	| StackPathsService;

/** A FACTORY for the supervisor command handler. The seam runs it ONCE,
 *  inside the supervised body (so `CommandHandlerServices` — notably the live
 *  `SnapshotOrchestratorService` + `FileSystem` — are in scope), BEFORE it
 *  hands `startSupervisor` the resolved handler. So the resulting handler
 *  (whose own R-channel is `never`, as the supervisor command loop requires)
 *  closes over the seam's REAL substrate instances directly — no Deferred
 *  hand-off. Resolving the snapshot orchestrator here yields the SAME
 *  instance the contribution dispatcher registers live participants on, so an
 *  operator `snapshot save` captures the LIVE chain/blob/db state, not an
 *  empty set off a sibling orchestrator. */
export type CommandHandlerFactory = Effect.Effect<
	SupervisorCommandHandler,
	never,
	CommandHandlerServices
>;

/** `RunStackOptions` plus the non-public injection points. `commandHandler`
 *  is a FACTORY the seam resolves against its live substrate (see
 *  {@link CommandHandlerFactory}); `boot` carries the caller-injected hooks. */
export interface RunStackOptionsWithBoot extends RunStackOptions {
	readonly commandHandler?: CommandHandlerFactory;
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
// Boot-time handle slots
// -----------------------------------------------------------------------------

/** The mutable cells + ref the handle's lifecycle effects close over. Every
 *  field is allocated SYNCHRONOUSLY in `makeRunHandleSlots` (see its
 *  sync-safety contract) so the public handle can expose a live `state` /
 *  `commands` queue and let callers subscribe to `state.changes` BEFORE
 *  `start` ever forks the supervisor fiber. */
interface RunHandleSlots {
	/** The supervisor's live projection. Seeded sync; populated by the
	 *  supervised body once it boots. */
	readonly state: SubscriptionRef.SubscriptionRef<
		import('../substrate/projection.ts').SubscribableState
	>;
	/** Resolved (or failed with `BootError`) by the readiness gate; `start`
	 *  awaits it. */
	readonly bootDeferred: Deferred.Deferred<void, BootError>;
	/** Set by `stop`; the built-in stop-bridge awaits it and offers
	 *  `shutdown.requested` onto the supervisor's command channel. */
	readonly stopRequested: Deferred.Deferred<void>;
	/** Handed the supervisor's event dequeue by `beforeInitialAcquire`; the
	 *  public `events` stream unwraps it. */
	readonly eventQueueRef: Deferred.Deferred<Queue.Dequeue<EngineEvent>>;
	/** Public command channel, pumped onto the supervisor's own queue once it
	 *  boots — the TUI/IPC publish target. */
	readonly commandQueue: Queue.Queue<EngineCommand>;
	/** Handed the supervisor's submit-and-await dispatch by
	 *  `beforeInitialAcquire`; the public `runCommand` awaits it. */
	readonly runCommandRef: Deferred.Deferred<
		(command: EngineCommand) => Effect.Effect<void, unknown, never>
	>;
	/** Holds the forked supervisor fiber; `stop`/`awaitShutdown` await it. */
	readonly fiberRef: Deferred.Deferred<Fiber.Fiber<void, never>>;
	/** Single-fire guard so a second `start` is a no-op. */
	readonly startClaim: Ref.Ref<boolean>;
	/** Tee for a mid-run defect/failure raised AFTER boot completed, so
	 *  `awaitShutdown` can re-surface it (a post-boot `Deferred.fail` is a
	 *  no-op). */
	readonly midRunCauseRef: Ref.Ref<Cause.Cause<unknown> | null>;
}

/**
 * Allocate every boot-time handle slot in ONE place.
 *
 * SYNC-SAFETY CONTRACT (the reason this is a sync constructor, not an
 * `Effect`): the handle must expose a real `state` / `commands` queue and
 * be subscribable BEFORE `start` forks the supervisor. `Deferred.make`,
 * `Queue.unbounded`, and `Ref.make` are pure sync effects (no side effects,
 * no async), so `Effect.runSync` is safe for all of them. The projection ref
 * goes through the explicit `makeProjectionRefSync` so the sync contract is
 * pinned at the substrate constructor — if `makeProjectionRef` ever picks up
 * an async/Layer wrapper (`withSpan`, annotation), `makeProjectionRefSync`
 * must stay sync-only or this whole allocation must move behind a
 * Deferred-handoff seam.
 */
const makeRunHandleSlots = (): RunHandleSlots => ({
	state: makeProjectionRefSync(),
	bootDeferred: Effect.runSync(Deferred.make<void, BootError>()),
	stopRequested: Effect.runSync(Deferred.make<void>()),
	eventQueueRef: Effect.runSync(Deferred.make<Queue.Dequeue<EngineEvent>>()),
	commandQueue: Effect.runSync(Queue.unbounded<EngineCommand>()),
	runCommandRef: Effect.runSync(
		Deferred.make<(command: EngineCommand) => Effect.Effect<void, unknown, never>>(),
	),
	fiberRef: Effect.runSync(Deferred.make<Fiber.Fiber<void, never>>()),
	startClaim: Effect.runSync(Ref.make(false)),
	midRunCauseRef: Effect.runSync(Ref.make<Cause.Cause<unknown> | null>(null)),
});

/** Compose the public handle + the live `SupervisorHandle` into the
 *  `InternalRunHandle` the caller boot hooks receive. The two composed hooks
 *  build it identically; factored here so the closure-soundness note (the
 *  hooks only deref `publicHandle` at boot, after the body assigns it) lives
 *  in one place. */
const buildInternalHandle = (
	publicHandle: RunHandle,
	supervisor: SupervisorHandle,
): InternalRunHandle => ({ ...publicHandle, supervisor });

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

	// Every boot-time handle slot is allocated in ONE place (the sync-safety
	// contract lives on `makeRunHandleSlots`): the handle must expose a live
	// `state` / `commands` queue and be subscribable BEFORE `start` forks the
	// supervisor fiber.
	const {
		state,
		bootDeferred,
		stopRequested,
		eventQueueRef,
		commandQueue,
		runCommandRef,
		fiberRef,
		startClaim,
		midRunCauseRef,
	} = makeRunHandleSlots();

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
		// Resolve the command-handler FACTORY against the seam's live
		// substrate (in scope here via `Effect.provide(substrate)` below)
		// BEFORE `startSupervisor` consumes the handler. The factory closes
		// over the same `SnapshotOrchestratorService` the contribution
		// dispatcher registers participants on, so the resulting handler
		// (R = `never`, as the command loop requires) drives the LIVE state.
		const commandHandler =
			opts.commandHandler === undefined ? undefined : yield* opts.commandHandler;
		// The shared production-boot assembly (contribution dispatcher +
		// post-acquire hook + built-in plugin-context extension, then
		// `layerBuiltInPluginRuntime`) lives in ONE place
		// (`orchestrators/boot.ts superviseStackWithProductionBoot`). This
		// seam supplies only the LONG-RUNNING-specific wrapping: the
		// resolved command handler, the public `runStack({ extendContext })`
		// chained after the built-in, and the composed boot hooks below.
		yield* superviseStackWithProductionBoot(supervisedStack, identity, state, {
			extras: stack.options.extras,
			...(opts.boot?.devstackVersion === undefined
				? {}
				: { devstackVersion: opts.boot.devstackVersion }),
			...(commandHandler === undefined ? {} : { commandHandler }),
			...(opts.extendContext === undefined
				? {}
				: { extendContextAfterBuiltIn: opts.extendContext }),
			// ── COMPOSED `beforeInitialAcquire` (ONE ordered gen) ──────────
			// ORDER (PR#21-load-bearing): BUILT-IN work first, THEN caller.
			//   1. built-in: event-queue handoff + runCommand surface +
			//      command-pump fork + stop-bridge fork.
			//   2. caller: `opts.boot?.beforeInitialAcquire(...)`.
			// `superviseStackEffect` runs this whole composed effect BEFORE
			// `runInitialAcquire`, so the caller hook (the CLI's recover/
			// roster/IPC/TUI bundle) runs before first acquire too; and because
			// the built-in stop-bridge is armed first, a `stop()` raised during
			// a caller hook always has a command bridge.
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
						yield* opts.boot.beforeInitialAcquire(buildInternalHandle(publicHandle, handle));
					}
				}),
			// ── COMPOSED `withinScope` (ONE ordered gen) ───────────────────
			// ORDER: BUILT-IN readiness-gate resolution first, THEN caller.
			//   1. built-in: the status scan that resolves `bootDeferred`.
			//   2. caller: `opts.boot?.withinScope(...)`.
			// Resolving the gate first means a caller `withinScope` can never
			// delay `handle.start`.
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
						yield* opts.boot.withinScope(buildInternalHandle(publicHandle, handle));
					}
				}),
		});
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
