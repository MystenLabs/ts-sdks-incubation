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

import { Deferred, Effect, Queue, Ref, Scope } from 'effect';

import type { EngineCommand } from '../../events.ts';
import {
	runInjectedCommandHandler,
	runPostAcquireHook,
	startBackgroundSnapshotCapture,
	startBackgroundStackRestart,
} from './background-tasks.ts';
import { SupervisorPostAcquireFailed } from './errors.ts';
import { handleHardKillRequested, handleShutdownRequested } from './shutdown.ts';
import { allReadyOrTerminal, type SupervisorState } from './state.ts';
import { doSelectiveRestart } from './teardown.ts';
import { planFullDrain } from '../lifecycle/index.ts';

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
): Effect.Effect<void, SupervisorPostAcquireFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const { graph, registry, pluginContext, sinks, logger, identity, runtimeRoot } = deps;
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
				const plan = planFullDrain(graph);
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set(plan.slice),
					pluginContext,
					sinks,
					logger,
					identity,
					runtimeRoot,
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
					sinks,
					logger,
					identity,
					runtimeRoot,
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
						sinks,
						logger,
						identity,
						runtimeRoot,
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
			case 'snapshot.capture':
				yield* startBackgroundSnapshotCapture(deps, cmd);
				return;
			case 'snapshot.restore': {
				// Restore is destructive: the injected handler applies the
				// on-disk tree AND removes the live managed containers, relying
				// on the NEXT acquire to rebuild them. The CLI offline path gets
				// that acquire for free (supervisor was DOWN, boots fresh after).
				// For a LIVE supervisor (the dashboard path) nothing else
				// re-acquires — so we chain a full drain + re-acquire here,
				// mirroring `stack.restart`. Net effect = the manual-restart
				// sequence the user confirmed works: apply restored tree, then
				// drain + re-acquire every service from it. The handler runs
				// first (and publishes `snapshot.restored`); we only re-acquire
				// once it succeeded.
				yield* runInjectedCommandHandler(deps, cmd);
				const plan = planFullDrain(graph);
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					deps.ref,
					deps.hub,
					new Set(plan.slice),
					pluginContext,
					sinks,
					logger,
					identity,
					runtimeRoot,
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

export const commandLoop = (deps: SupervisorState): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		while (true) {
			const next = yield* Queue.take(deps.queuedCommands);
			if (next.kind === 'submitted') {
				const exit = yield* Effect.exit(
					handleCommand(deps, next.submission.command, { failOnPostAcquireHook: true }),
				);
				yield* Deferred.succeed(next.submission.completion, exit).pipe(Effect.ignore);
			} else if (next.command.tag === 'stack.restart') {
				yield* startBackgroundStackRestart(deps, handleCommand);
			} else {
				yield* handleCommand(deps, next.command).pipe(Effect.catch(() => Effect.void));
			}
			const drained = yield* Ref.get(deps.shutdownLatch);
			if (drained) return;
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.commandLoop'));
