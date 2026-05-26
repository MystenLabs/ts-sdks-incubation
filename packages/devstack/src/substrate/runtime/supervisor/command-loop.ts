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

import { Deferred, Effect, Queue, Ref } from 'effect';

import type { EngineCommand } from '../../events.ts';
import type {
	PluginRegistry,
	ResolvedGraph,
} from '../lifecycle/index.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import { isReadyOrTerminal } from '../lifecycle/index.ts';
import {
	runInjectedCommandHandler,
	runPostAcquireHook,
	startBackgroundSnapshotCapture,
	startBackgroundStackRestart,
} from './background-tasks.ts';
import { SupervisorPostAcquireFailed } from './errors.ts';
import {
	handleHardKillRequested,
	handleShutdownRequested,
} from './shutdown.ts';
import type { SupervisorState } from './state.ts';
import { doSelectiveRestart } from './teardown.ts';
import { planFullDrain } from '../lifecycle/index.ts';

const allReadyOrTerminal = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
): Effect.Effect<boolean, never, never> =>
	Effect.gen(function* () {
		for (const key of graph.nodes.keys()) {
			const status = yield* registry
				.getStatus(key)
				.pipe(Effect.catch(() => Effect.succeed<LifecycleStatus>('failed')));
			if (!isReadyOrTerminal(status)) return false;
		}
		return true;
	});

export const handleCommand = (
	deps: SupervisorState,
	cmd: EngineCommand,
	options: { readonly failOnPostAcquireHook?: boolean } = {},
): Effect.Effect<void, SupervisorPostAcquireFailed, never> =>
	Effect.gen(function* () {
		const {
			graph,
			registry,
			pluginContext,
			sinks,
			logger,
			identity,
			runtimeRoot,
			parentScope,
		} = deps;
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
					if (options.failOnPostAcquireHook === true) {
						yield* runPostAcquireHook(deps);
					} else {
						yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
					}
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
					if (options.failOnPostAcquireHook === true) {
						yield* runPostAcquireHook(deps);
					} else {
						yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
					}
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
						if (options.failOnPostAcquireHook === true) {
							yield* runPostAcquireHook(deps);
						} else {
							yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
						}
					}
					return;
				}
				if (yield* allReadyOrTerminal(graph, registry)) {
					if (options.failOnPostAcquireHook === true) {
						yield* runPostAcquireHook(deps);
					} else {
						yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
					}
				}
				return;
			}
			case 'codegen.requested': {
				if (yield* allReadyOrTerminal(graph, registry)) {
					if (options.failOnPostAcquireHook === true) {
						yield* runPostAcquireHook(deps);
					} else {
						yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
					}
				}
				return;
			}
			// Snapshot/wipe/prune are owned by injected L3 handlers. The
			// supervisor keeps one consumer of the command queue and only
			// publishes the handler's typed events / errors.
			case 'snapshot.capture':
				yield* startBackgroundSnapshotCapture(deps, cmd);
				return;
			case 'snapshot.restore':
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

export const commandLoop = (deps: SupervisorState): Effect.Effect<void, never, never> =>
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
