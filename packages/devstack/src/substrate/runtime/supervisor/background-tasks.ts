// Background tasks: injected command handler runner, snapshot capture,
// stack restart, and post-acquire hook.
//
// Each long-running background task (snapshot capture, stack restart) is
// forked into the SUPERVISOR-LIFETIME scope via `Effect.forkIn` so it
// rides the supervisor's lifetime rather than the command-loop fiber — a
// forked capture must not wedge shutdown (Bug #13). The live fiber IS the
// task's running state: it's held in a `BackgroundTaskSlot`
// (`Ref<Fiber | null>`); a second concurrent trigger sees a non-null slot
// and is skipped (skip-dedup), and a conflicting command reads-and-clears
// the slot then `Fiber.interrupt`s it. This is the Effect-native
// replacement for the hand-rolled idle/starting/running token Ref machine.

import { Cause, Effect, Exit, Fiber, Ref, Scope } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineCommand, EngineEvent } from '../../events.ts';
import { prettyErrorStructured } from '../observability/index.ts';
import { PostAcquireTaskFailed } from '../post-acquire-tasks.ts';
import { SupervisorPostAcquireFailed, SupervisorRestoreFailed } from './errors.ts';
import type { BackgroundTaskSlot, SupervisorState } from './state.ts';
import { bestEffort, publish } from './wiring.ts';

// Forward reference: the stack-restart background task runs through
// the same `handleCommand` dispatch path that the command loop uses;
// imports cycle if we hoist it directly, so we accept a runner from the
// caller.
type HandleCommandRunner = (
	deps: SupervisorState,
	cmd: EngineCommand,
) => Effect.Effect<void, SupervisorPostAcquireFailed | SupervisorRestoreFailed, Scope.Scope>;

/** `snapshot.captureFailed` / `snapshot.captureSkipped` carry a REQUIRED
 *  `snapshotId`. When the originating command carried an id, surfaces
 *  correlate the outcome with it (the CLI's pending-capture map keys on
 *  it). When the command omitted an id there is nothing to correlate
 *  against — the CLI's bridge does NOT register a pending-capture entry
 *  for an id-less capture (`cli/wirings/up.ts` falls through to a
 *  legacy auto-ack and never keys this synthetic id) — so the minted
 *  `snap-<ts>` here only satisfies the event's required field. */
const effectiveSnapshotId = (
	cmd: Extract<EngineCommand, { readonly tag: 'snapshot.capture' }>,
): string => cmd.snapshotId ?? `snap-${Date.now()}`;

/**
 * Run the injected L3 command handler and report the typed outcome.
 *
 * On success the handler's events are published and `ok: true` is
 * returned. On failure the failure is surfaced on the event stream
 * (`snapshot.captureFailed` for a capture, plus `error.reported`) AND
 * the cause is returned to the caller so a command that must NOT
 * proceed on a half-applied handler (e.g. `snapshot.restore`, which
 * otherwise drains + re-acquires every service off a half-restored
 * tree) can short-circuit and propagate the failure to `submitCommand`.
 *
 * Interrupt-only causes return `ok: true` (the interrupting sibling
 * owns the lifecycle decision) — same as the void runner below.
 */
export const runInjectedCommandHandlerExit = (
	deps: SupervisorState,
	cmd: EngineCommand,
): Effect.Effect<
	{ readonly ok: true } | { readonly ok: false; readonly cause: Cause.Cause<unknown> },
	never,
	never
> =>
	Effect.gen(function* () {
		if (deps.commandHandler === undefined) return { ok: true } as const;
		const publishFromHandler = (event: EngineEvent): Effect.Effect<void, never, never> =>
			publish(deps.ref, deps.hub, event);
		const exit = yield* Effect.exit(
			deps.commandHandler(cmd, {
				publish: publishFromHandler,
			}),
		);
		if (Exit.isSuccess(exit)) {
			for (const event of exit.value) {
				yield* publish(deps.ref, deps.hub, event);
			}
			return { ok: true } as const;
		}
		if (Cause.hasInterruptsOnly(exit.cause)) return { ok: true } as const;
		if (cmd.tag === 'snapshot.capture') {
			yield* publish(deps.ref, deps.hub, {
				tag: 'snapshot.captureFailed',
				snapshotId: effectiveSnapshotId(cmd),
				...(cmd.name === undefined ? {} : { name: cmd.name }),
				summary: Cause.pretty(exit.cause).split('\n')[0] ?? 'snapshot capture failed',
				at: Date.now(),
			});
		}
		yield* publish(deps.ref, deps.hub, {
			tag: 'error.reported',
			error: prettyErrorStructured(exit.cause, {
				pluginKey: null,
				severity: 'error',
				at: Date.now(),
			}),
		});
		yield* deps.logger.log('supervisor', null, {
			level: 'error',
			message: `command handler failed for ${cmd.tag}`,
		});
		return { ok: false, cause: exit.cause } as const;
	}).pipe(Effect.withSpan('lifecycle.supervisor.injectedCommandHandler'));

/**
 * Fire-and-forget wrapper over {@link runInjectedCommandHandlerExit}:
 * the handler's failure is already surfaced on the event stream, so the
 * void channel suffices for capture / list / delete / wipe / prune,
 * whose callers don't branch on the outcome.
 */
export const runInjectedCommandHandler = (
	deps: SupervisorState,
	cmd: EngineCommand,
): Effect.Effect<void, never, never> => Effect.asVoid(runInjectedCommandHandlerExit(deps, cmd));

/**
 * Fork `body` into the supervisor-lifetime scope and claim a background
 * task slot atomically.
 *
 * `Effect.forkIn(supervisorScope)` parents the fiber to the supervisor's
 * lifetime — NOT the command-loop fiber that triggered it — so a
 * long-running capture/restart does not block the command loop and
 * cannot wedge a subsequent `shutdown.requested` (Bug #13). The forked
 * fiber is created suspended (`forkIn`'s default `startImmediately`), so
 * the CAS below runs before it executes a single step.
 *
 * Skip-dedup: the slot is the running state. If it is already occupied
 * the just-forked fiber is interrupted (it never ran) and the function
 * returns `'skipped'` so the caller can publish/log the skip. Otherwise
 * the fiber is installed, its `ensuring` clears the slot on completion,
 * and the function returns `'started'`.
 */
const forkIntoSlot = (
	supervisorScope: Scope.Scope,
	slot: BackgroundTaskSlot,
	body: Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<'started' | 'skipped', never, never> =>
	Effect.gen(function* () {
		// Self-clear the slot when the task settles (success OR interrupt),
		// but only if it still holds THIS fiber — a racing interrupt
		// (`interruptSlot`) may have already swapped it to `null`, or a
		// subsequent task may already own the slot. Comparing on the running
		// fiber's own id makes this self-contained (no fork-then-store hole).
		const guarded = Effect.gen(function* () {
			const selfId = yield* Effect.fiberId;
			yield* body.pipe(
				Effect.ensuring(
					Ref.update(slot, (current) => (current !== null && current.id === selfId ? null : current)),
				),
			);
		});
		// Provide the supervisor scope to the body (so a forked restart's
		// `doSelectiveRestart` parents its plugin scopes off the supervisor's
		// lifetime, as the former `forkScoped` did) and fork into that same
		// scope so the fiber rides the supervisor's lifetime — NOT the
		// command-loop fiber that triggered it. `forkIn` does not start the
		// fiber immediately, so the CAS-claim below runs first.
		const fiber = yield* Effect.forkIn(Scope.provide(guarded, supervisorScope), supervisorScope);
		const claimed = yield* Ref.modify(slot, (current) =>
			current === null ? [true, fiber] : [false, current],
		);
		if (!claimed) {
			// Slot already held by a running task — interrupt the fiber we
			// just forked (it has not run yet) and report the skip.
			yield* Fiber.interrupt(fiber);
			return 'skipped' as const;
		}
		return 'started' as const;
	});

/**
 * Read-and-clear a background task slot, then await the fiber's
 * interrupt. Awaiting matters: a follow-up snapshot capture must not
 * begin while the previous fiber is still inside `pauseAndCommit` /
 * `saveImages`, and shutdown must not race a half-torn-down restart.
 */
const interruptSlot = (slot: BackgroundTaskSlot): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const fiber = yield* Ref.getAndSet(slot, null);
		if (fiber !== null) {
			yield* Fiber.interrupt(fiber);
		}
	});

export const startBackgroundStackRestart = (
	deps: SupervisorState,
	handleCommand: HandleCommandRunner,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const outcome = yield* forkIntoSlot(
			deps.supervisorScope,
			deps.stackRestartTask,
			handleCommand(deps, { tag: 'stack.restart' }).pipe(Effect.catch(() => Effect.void)),
		);
		if (outcome === 'skipped') {
			yield* deps.logger.log('supervisor', null, {
				level: 'debug',
				message: 'stack restart skipped because one is already running',
			});
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.backgroundStackRestart'));

export const requestBackgroundStackRestartInterrupt = (
	deps: Pick<SupervisorState, 'stackRestartTask'>,
): Effect.Effect<void, never, never> =>
	interruptSlot(deps.stackRestartTask).pipe(
		Effect.withSpan('lifecycle.supervisor.interruptStackRestart'),
	);

// -----------------------------------------------------------------------------
// Post-acquire hook
// -----------------------------------------------------------------------------

const publishHookFailure = (
	deps: SupervisorState,
	cause: Cause.Cause<unknown>,
	message: string,
	pluginKey: PluginKey | null = null,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		yield* publish(deps.ref, deps.hub, {
			tag: 'error.reported',
			error: prettyErrorStructured(cause, {
				pluginKey,
				severity: 'error',
				at: Date.now(),
			}),
		});
		yield* deps.logger.log('supervisor', null, {
			level: 'error',
			message,
		});
	});

const findPostAcquireTaskFailure = (cause: Cause.Cause<unknown>): PostAcquireTaskFailed | null => {
	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;
		if (reason.error instanceof PostAcquireTaskFailed) return reason.error;
	}
	return null;
};

export const runPostAcquireHook = (
	deps: SupervisorState,
): Effect.Effect<void, SupervisorPostAcquireFailed, never> =>
	Effect.gen(function* () {
		if (deps.postAcquireHook === undefined) return;
		const exit = yield* Effect.exit(
			deps.postAcquireHook({
				graph: deps.graph,
				registry: deps.registry,
				identity: deps.identity,
				runtimeRoot: deps.runtimeRoot,
			}),
		);
		if (Exit.isSuccess(exit)) {
			for (const event of exit.value) {
				yield* publish(deps.ref, deps.hub, event);
			}
			return;
		}
		const taskFailure = findPostAcquireTaskFailure(exit.cause);
		if (taskFailure !== null) {
			yield* bestEffort(deps.registry.markFailed(taskFailure.pluginKey, taskFailure.cause));
		}
		yield* publishHookFailure(
			deps,
			exit.cause,
			taskFailure === null
				? 'post-acquire hook failed'
				: `post-acquire task failed: ${taskFailure.label}`,
			taskFailure?.pluginKey ?? null,
		);
		return yield* Effect.fail(new SupervisorPostAcquireFailed({ cause: exit.cause }));
	}).pipe(Effect.withSpan('lifecycle.supervisor.postAcquireHook'));
