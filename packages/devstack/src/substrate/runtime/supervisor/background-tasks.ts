// Background tasks: injected command handler runner, snapshot capture,
// stack restart, and post-acquire hook.
//
// Each background task is forked into the supervisor's parent scope so
// it rides the supervisor's lifetime rather than the command-loop
// fiber. Interrupt requests use a Ref-typed handle (`idle`/`starting`/
// `running`) so a sibling command can interrupt a running task without
// racing the fork.

import { Cause, Effect, Exit, Fiber, Ref } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineCommand, EngineEvent } from '../../events.ts';
import { prettyErrorStructured } from '../observability/index.ts';
import { PostAcquireTaskFailed } from '../post-acquire-tasks.ts';
import { SupervisorPostAcquireFailed } from './errors.ts';
import type {
	SnapshotCaptureTaskState,
	StackRestartTaskState,
	SupervisorState,
} from './state.ts';
import { publish } from './wiring.ts';

// Forward reference: the stack-restart background task runs through
// the same `handleCommand` dispatch path that the command loop uses;
// imports cycle if we hoist it directly, so we accept a runner from the
// caller.
type HandleCommandRunner = (
	deps: SupervisorState,
	cmd: EngineCommand,
) => Effect.Effect<void, SupervisorPostAcquireFailed, never>;

export const runInjectedCommandHandler = (
	deps: SupervisorState,
	cmd: EngineCommand,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		if (deps.commandHandler === undefined) return;
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
			return;
		}
		if (Cause.hasInterruptsOnly(exit.cause)) return;
		if (cmd.tag === 'snapshot.capture') {
			yield* publish(deps.ref, deps.hub, {
				tag: 'snapshot.captureFailed',
				...(cmd.snapshotId === undefined ? {} : { snapshotId: cmd.snapshotId }),
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
	}).pipe(Effect.withSpan('lifecycle.supervisor.injectedCommandHandler'));

export const startBackgroundSnapshotCapture = (
	deps: SupervisorState,
	cmd: Extract<EngineCommand, { readonly tag: 'snapshot.capture' }>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const token = yield* Ref.updateAndGet(deps.snapshotCaptureSeq, (n) => n + 1);
		const started = yield* Ref.modify(deps.snapshotCaptureTask, (state) =>
			state.tag === 'idle'
				? [
						true,
						{
							tag: 'starting' as const,
							token,
							snapshotId: cmd.snapshotId ?? null,
						} satisfies SnapshotCaptureTaskState,
					]
				: [false, state],
		);

		if (!started) {
			yield* publish(deps.ref, deps.hub, {
				tag: 'snapshot.captureSkipped',
				reason: 'already-running',
				...(cmd.snapshotId === undefined ? {} : { snapshotId: cmd.snapshotId }),
				...(cmd.name === undefined ? {} : { name: cmd.name }),
				at: Date.now(),
			});
			return;
		}

		yield* publish(deps.ref, deps.hub, {
			tag: 'snapshot.captureStarted',
			...(cmd.snapshotId === undefined ? {} : { snapshotId: cmd.snapshotId }),
			...(cmd.name === undefined ? {} : { name: cmd.name }),
			at: Date.now(),
		});

		const fiber = yield* runInjectedCommandHandler(deps, cmd).pipe(
			Effect.ensuring(
				Ref.update(deps.snapshotCaptureTask, (state) =>
					state.tag !== 'idle' && state.token === token
						? ({ tag: 'idle' } satisfies SnapshotCaptureTaskState)
						: state,
				),
			),
			Effect.forkIn(deps.parentScope),
		);

		yield* Ref.update(deps.snapshotCaptureTask, (state) =>
			state.tag === 'starting' && state.token === token
				? ({
						tag: 'running',
						token,
						snapshotId: cmd.snapshotId ?? null,
						fiber,
					} satisfies SnapshotCaptureTaskState)
				: state,
		);
	}).pipe(Effect.withSpan('lifecycle.supervisor.backgroundSnapshotCapture'));

export const requestBackgroundSnapshotInterrupt = (
	deps: Pick<SupervisorState, 'snapshotCaptureTask'>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const fiber = yield* Ref.modify(deps.snapshotCaptureTask, (state) =>
			state.tag === 'running'
				? [state.fiber, { tag: 'idle' } as SnapshotCaptureTaskState]
				: [null, state],
		);
		if (fiber !== null) {
			yield* Effect.sync(() => {
				fiber.interruptUnsafe();
			});
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.interruptSnapshotCapture'));

export const startBackgroundStackRestart = (
	deps: SupervisorState,
	handleCommand: HandleCommandRunner,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const token = yield* Ref.updateAndGet(deps.stackRestartSeq, (n) => n + 1);
		const started = yield* Ref.modify(deps.stackRestartTask, (state) =>
			state.tag === 'idle' ? [true, { tag: 'starting' as const, token }] : [false, state],
		);

		if (!started) {
			yield* deps.logger.log('supervisor', null, {
				level: 'debug',
				message: 'stack restart skipped because one is already running',
			});
			return;
		}

		const fiber = yield* handleCommand(deps, { tag: 'stack.restart' }).pipe(
			Effect.catch(() => Effect.void),
			Effect.ensuring(
				Ref.update(deps.stackRestartTask, (state) =>
					state.tag !== 'idle' && state.token === token
						? ({ tag: 'idle' } satisfies StackRestartTaskState)
						: state,
				),
			),
			Effect.forkIn(deps.parentScope),
		);

		yield* Ref.update(deps.stackRestartTask, (state) =>
			state.tag === 'starting' && state.token === token
				? ({ tag: 'running', token, fiber } satisfies StackRestartTaskState)
				: state,
		);
	}).pipe(Effect.withSpan('lifecycle.supervisor.backgroundStackRestart'));

export const requestBackgroundStackRestartInterrupt = (
	deps: Pick<SupervisorState, 'stackRestartTask'>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const fiber = yield* Ref.modify(deps.stackRestartTask, (state) =>
			state.tag === 'running'
				? [state.fiber, { tag: 'idle' } as StackRestartTaskState]
				: [null, state],
		);
		if (fiber !== null) {
			yield* Fiber.interrupt(fiber);
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.interruptStackRestart'));

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
			yield* deps.registry
				.markFailed(taskFailure.pluginKey, taskFailure.cause)
				.pipe(Effect.catch(() => Effect.void));
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
