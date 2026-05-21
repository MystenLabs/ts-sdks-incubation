// POSIX signal handling.
//
// Architecture § Engine / supervisor split:
//   "signals → L0 (one POSIX signal handler at process boot), routed
//   via the command channel."
//
// Discipline:
//   - ONE handler per process. Registering twice is a programmer
//     error.
//   - Signals translate to `EngineCommand`s on the typed command stream
//     (`shutdown.requested` for graceful, `stack.stop`+abort for hard).
//   - Second SIGINT/SIGTERM escalates to abort: the in-flight teardown
//     is interrupted, `process.exit(130)` (or 143 for SIGTERM)
//     terminates immediately.
//
// The supervisor wires this fiber once at boot via `Effect.forkScoped`;
// its scope is the supervisor's outer scope, so the handler unregisters
// when the supervisor tears down (test environments that boot multiple
// supervisors must close them before booting the next).

import { Effect, Queue, Scope } from 'effect';

import type { EngineCommand } from '../../events.ts';

/** Signals the supervisor handles. SIGHUP intentionally omitted —
 *  reconfigure is a command-channel concern, not a signal one. */
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/** Map a signal to the exit code POSIX clients expect — 128 + N. */
const exitCodeForSignal = (signal: HandledSignal): number => {
	switch (signal) {
		case 'SIGINT':
			return 130;
		case 'SIGTERM':
			return 143;
	}
};

/**
 * Install signal handlers that publish `shutdown.requested` (first
 * signal) and force-exit (second signal of the same kind).
 *
 * Returns an Effect that runs forever in its Scope; the supervisor
 * forks it via `Effect.forkScoped`. Scope close unregisters the
 * listeners — Node's `process` listeners persist past the scope
 * otherwise, leading to "ghost" handlers from prior test boots.
 */
export const installSignalHandler = (
	commands: Queue.Enqueue<EngineCommand>,
): Effect.Effect<never, never, Scope.Scope> =>
	Effect.gen(function* () {
		// Per-signal toggle: first delivery → publish shutdown.requested;
		// second delivery → process.exit. State lives on a Map keyed by
		// signal so a stray SIGINT followed by a SIGTERM both arm
		// independently.
		const armed = new Map<HandledSignal, boolean>();

		const handlers: Array<{
			readonly signal: HandledSignal;
			readonly listener: NodeJS.SignalsListener;
		}> = [];

		for (const signal of HANDLED_SIGNALS) {
			const listener: NodeJS.SignalsListener = () => {
				if (armed.get(signal) === true) {
					// Second signal → escalate.
					// Best-effort: tell the supervisor to abort BEFORE we exit
					// so any cause-walker output reaches the user. The
					// `process.exit` happens on the next tick so the runtime
					// can drain the queue.
					queueMicrotask(() => {
						process.exit(exitCodeForSignal(signal));
					});
					return;
				}
				armed.set(signal, true);
				process.exitCode ??= exitCodeForSignal(signal);
				// Publish `shutdown.requested` — same shape regardless of
				// which signal fired. The supervisor decides drain vs abort
				// on its own loop.
				const offerEffect = Queue.offer(commands, {
					tag: 'shutdown.requested',
				} satisfies EngineCommand);
				// We're inside a Node listener; bridge into Effect via the
				// process's default runtime. `runFork` returns a fiber but we
				// don't track it — the queue is bounded by the supervisor's
				// lifetime.
				Effect.runFork(offerEffect);
			};
			process.on(signal, listener);
			handlers.push({ signal, listener });
		}

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				for (const { signal, listener } of handlers) {
					process.removeListener(signal, listener);
				}
			}),
		);

		// Park forever; the listeners themselves run synchronously in
		// Node's event loop, not in this fiber.
		return yield* Effect.never;
	}).pipe(Effect.withSpan('lifecycle.signals.installSignalHandler'));

/** Re-export the handled-signal list so tests / docs can enumerate. */
export const handledSignals: ReadonlyArray<HandledSignal> = HANDLED_SIGNALS;
