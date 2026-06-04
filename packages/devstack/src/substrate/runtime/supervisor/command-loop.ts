// Supervisor command-loop.
//
// One consumer of the `queuedCommands` channel. Each iteration:
//   1. Take the next queued command (fire-and-forget OR submitted).
//   2. Dispatch via `handleCommand`. Submitted commands carry a
//      `completion` deferred so the publisher can await the exit.
//   3. Re-check the shutdown latch — exit the loop when set.
//
// `handleCommand` switches by tag and delegates to the per-concern
// modules (shutdown, teardown, selective-restart, background-tasks).

import { Cause, Deferred, Effect, Queue, Ref, Scope } from 'effect';

import type { EngineCommand } from '../../events.ts';
import {
	runInjectedCommandHandler,
	runInjectedCommandHandlerExit,
	runPostAcquireHook,
	startBackgroundStackRestart,
} from './background-tasks.ts';
import { SupervisorRestoreFailed, SupervisorPostAcquireFailed } from './errors.ts';
import { handleHardKillRequested, handleShutdownRequested } from './shutdown.ts';
import { allReadyOrTerminal, type QueuedCommand, type SupervisorState } from './state.ts';
import { doSelectiveRestart } from './teardown.ts';
import { publish } from './wiring.ts';
import { planExcluding } from '../lifecycle/index.ts';

const maybeRunPostAcquire = (
	deps: SupervisorState,
	options: { readonly failOnPostAcquireHook?: boolean },
): Effect.Effect<void, SupervisorPostAcquireFailed, never> =>
	options.failOnPostAcquireHook === true
		? runPostAcquireHook(deps)
		: runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));

export const handleCommand = (
	deps: SupervisorState,
	cmd: EngineCommand,
	options: { readonly failOnPostAcquireHook?: boolean } = {},
): Effect.Effect<void, SupervisorPostAcquireFailed | SupervisorRestoreFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const { graph, registry, pluginContext, dispatcher, logger, identity } = deps;
		const parentScope = yield* Effect.scope;
		switch (cmd.tag) {
			case 'shutdown.requested':
			case 'stack.stop': {
				yield* handleShutdownRequested(deps);
				return;
			}
			case 'shutdown.hardKillRequested': {
				yield* handleHardKillRequested(deps, cmd);
				return;
			}
			case 'stack.restart': {
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set(graph.nodes.keys()),
					pluginContext,
					dispatcher,
					logger,
					identity,
					parentScope,
				).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (restarted && (yield* allReadyOrTerminal(graph, registry))) {
					yield* maybeRunPostAcquire(deps, options);
				}
				return;
			}
			case 'selective-restart.requested': {
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set([cmd.pluginKey]),
					pluginContext,
					dispatcher,
					logger,
					identity,
					parentScope,
				).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (restarted && (yield* allReadyOrTerminal(graph, registry))) {
					yield* maybeRunPostAcquire(deps, options);
				}
				return;
			}
			case 'apply.requested': {
				// Re-acquire after watch invalidation. Caller may target a
				// specific plugin; otherwise no-op (the watcher already fed
				// `selective-restart.requested` for the affected keys).
				if (cmd.pluginKey !== undefined) {
					const restarted = yield* doSelectiveRestart(
						graph,
						registry,
						deps.ref,
						deps.hub,
						new Set([cmd.pluginKey]),
						pluginContext,
						dispatcher,
						logger,
						identity,
						parentScope,
					).pipe(
						Effect.as(true),
						Effect.catch(() => Effect.succeed(false)),
					);
					if (restarted && (yield* allReadyOrTerminal(graph, registry))) {
						yield* maybeRunPostAcquire(deps, options);
					}
					return;
				}
				if (yield* allReadyOrTerminal(graph, registry)) {
					yield* maybeRunPostAcquire(deps, options);
				}
				return;
			}
			case 'codegen.requested': {
				if (yield* allReadyOrTerminal(graph, registry)) {
					yield* maybeRunPostAcquire(deps, options);
				}
				return;
			}
			// Snapshot/wipe/prune are owned by injected L3 handlers. The
			// supervisor keeps one consumer of the command queue and only
			// publishes the handler's typed events / errors.
			case 'snapshot.capture': {
				// Capture is the lifecycle bounce, structurally IDENTICAL to
				// restore: the handler (`runCapture`) gathers (live) → graceful-
				// stops (flushes RocksDB) → commits + tars + writes meta → retags
				// each committed image onto its container's ORIGINAL name + HARD-rms
				// the stopped containers. This loop then runs the RESUME (CONVERGE
				// recreate-from-image + wait-write-ready): R1 removed the live
				// containers, so the re-acquire sees facts:null and recreates fresh
				// from the retagged committed images (whose names now resolve to the
				// flushed layers), inheriting walrus's write-ready ready-gate — so
				// the just-captured stack comes back write-ready (NEVER `docker
				// start`, which walrus nodes exit on). Mirrors `snapshot.restore`.
				const captureOutcome = yield* runInjectedCommandHandlerExit(deps, cmd);
				if (!captureOutcome.ok) {
					// The handler already surfaced the failure on the event stream
					// (`snapshot.captureFailed` + `error.reported`). A failed capture
					// left the containers only STOPPED (recoverable) — converge them
					// back so the stack returns to running, then propagate.
					const recoverPlan = planExcluding(graph, (node) => node.keepAliveOnRestore);
					if (recoverPlan.slice.size > 0) {
						yield* doSelectiveRestart(
							graph,
							registry,
							deps.ref,
							deps.hub,
							new Set(recoverPlan.slice),
							pluginContext,
							dispatcher,
							logger,
							identity,
							parentScope,
						).pipe(Effect.catch(() => Effect.void));
					}
					return yield* Effect.fail(
						new SupervisorRestoreFailed({ reason: 'handler', cause: captureOutcome.cause }),
					);
				}
				const plan = planExcluding(graph, (node) => node.keepAliveOnRestore);
				if (plan.slice.size === 0) {
					if (yield* allReadyOrTerminal(graph, registry)) {
						yield* maybeRunPostAcquire(deps, options);
					}
					return;
				}
				const recovered = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set(plan.slice),
					pluginContext,
					dispatcher,
					logger,
					identity,
					parentScope,
				).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
				const allReady = recovered && (yield* allReadyOrTerminal(graph, registry));
				if (!allReady) {
					return yield* Effect.fail(
						new SupervisorRestoreFailed({
							reason: 'reacquire',
							cause: Cause.fail(
								new Error(
									recovered
										? 'snapshot capture resume left one or more services not ready'
										: 'snapshot capture resume failed',
								),
							),
						}),
					);
				}
				yield* maybeRunPostAcquire(deps, options);
				return;
			}
			case 'snapshot.restore': {
				// Restore is the unified reconcile's ORDERED 4-step body
				// split across this loop and the injected handler: the handler
				// (`runRestore`) runs step0 (identity-guard
				// precondition, fail-closed) → step1 (fsPlan swap-tree(untar))
				// → step2 R1 (HARD container rm). This loop runs step2 R2
				// (CONVERGE recreate-from-fresh): since R1 already removed the
				// live managed containers, the next acquire sees facts:null and
				// creates fresh from the restored images. The CLI offline path
				// gets that converge for free (supervisor was DOWN, boots fresh
				// after). For a LIVE supervisor (the dashboard path) nothing else
				// re-acquires — so we chain a drain + re-acquire here via
				// `doSelectiveRestart`, which is itself routed through
				// `reconcileGraph(drain)∘reconcileGraph(converge)`, mirroring
				// `stack.restart`. The handler runs first (and publishes
				// `snapshot.restored`); we only converge once it succeeded.
				//
				// Drain EXCLUDES any plugin that declared `keepAliveOnRestore`
				// (the operator transport answering this restore) so a
				// restore-initiating connection isn't torn down mid-flight —
				// otherwise the `submitCommand` completion the resolver awaits
				// never reaches the client (502) even though the restore +
				// re-acquire succeeded. The substrate planner filters on that
				// node flag alone, with no knowledge of which plugins set it.
				//
				// The handler runs via the TYPED-exit runner (not the
				// error-swallowing void wrapper) so a FAILED restore (bad
				// snapshot id, or a failure AFTER the on-disk swap)
				// short-circuits: we must NOT drain + re-acquire every service off
				// a half-applied tree, and the submitted-command completion must
				// FAIL so the dashboard mutation reports `{ ok:false }` instead of
				// resolving success on `id:"does-not-exist"`.
				const restoreOutcome = yield* runInjectedCommandHandlerExit(deps, cmd);
				if (!restoreOutcome.ok) {
					return yield* Effect.fail(
						new SupervisorRestoreFailed({ reason: 'handler', cause: restoreOutcome.cause }),
					);
				}
				const plan = planExcluding(graph, (node) => node.keepAliveOnRestore);
				if (plan.slice.size === 0) {
					// Empty re-acquire slice (the stack's only members are
					// dashboard()/host-service(...), which carry `keepAliveOnRestore`):
					// `doSelectiveRestart` emits its `restart.*` settle events
					// per-root, so an empty slice would fire NONE and leave the
					// projection stuck at the `restoring` phase set on
					// `snapshot.restored`. Emit the settle ourselves so the phase
					// returns to `running`.
					yield* publish(deps.ref, deps.hub, {
						tag: 'restart.completed',
						target: 'stack',
						at: Date.now(),
					});
					if (yield* allReadyOrTerminal(graph, registry)) {
						yield* maybeRunPostAcquire(deps, options);
					}
					return;
				}
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set(plan.slice),
					pluginContext,
					dispatcher,
					logger,
					identity,
					parentScope,
				).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
				// Feed the REAL re-acquire outcome into the completion: a valid
				// snapshot whose re-acquire leaves any row `failed` (port conflict,
				// broken dep) must report `{ ok:false }`, not a green dashboard with
				// failed rows. `allReadyOrTerminal` collapses a failed/unreadable
				// node to non-ready, so this is the all-rows-ready gate.
				const allReady = restarted && (yield* allReadyOrTerminal(graph, registry));
				if (!allReady) {
					return yield* Effect.fail(
						new SupervisorRestoreFailed({
							reason: 'reacquire',
							cause: Cause.fail(
								new Error(
									restarted
										? 'snapshot restore re-acquire left one or more services not ready'
										: 'snapshot restore re-acquire failed',
								),
							),
						}),
					);
				}
				yield* maybeRunPostAcquire(deps, options);
				return;
			}
			case 'snapshot.list':
			case 'snapshot.delete':
			case 'wipe.requested':
			case 'prune.requested':
				yield* runInjectedCommandHandler(deps, cmd);
				return;
			case 'advance-clock.requested':
			case 'stack.start':
				return;
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.handleCommand'));

/**
 * Dispatch one dequeued command. The loop is the SOLE consumer of the
 * command queue, so the spine is: `dequeue → handle → await Exit →
 * ack|fail`. Three intents:
 *
 *  - `submitted` — the caller (`submitCommand`, the dashboard restore
 *    path) awaits the real exit, so run inline (`failOnPostAcquireHook`)
 *    and feed the Exit back through the completion deferred (the ack/fail).
 *  - fire-and-forget `stack.restart` — the watcher/keypress must not
 *    block the loop on a full re-acquire, so it forks into the
 *    supervisor scope (a second concurrent restart is skip-deduped).
 *  - every other fire-and-forget — run inline, swallowing failures (the
 *    handler already surfaced them on the event stream).
 */
const dispatch = (deps: SupervisorState, next: QueuedCommand): Effect.Effect<void, never, Scope.Scope> => {
	if (next.kind === 'submitted') {
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				handleCommand(deps, next.submission.command, { failOnPostAcquireHook: true }),
			);
			yield* Deferred.succeed(next.submission.completion, exit).pipe(Effect.ignore);
		});
	}
	if (next.command.tag === 'stack.restart') {
		return startBackgroundStackRestart(deps, handleCommand);
	}
	return handleCommand(deps, next.command).pipe(Effect.catch(() => Effect.void));
};

export const commandLoop = (deps: SupervisorState): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		while (true) {
			yield* dispatch(deps, yield* Queue.take(deps.queuedCommands));
			if (yield* Ref.get(deps.shutdownLatch)) return;
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.commandLoop'));
