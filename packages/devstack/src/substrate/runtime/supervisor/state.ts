// Supervisor shared-state record.
//
// `startSupervisor`'s `Effect.gen` body closes over ~20 locals. Rather
// than thread each one through every helper individually, we group
// them into a typed bag here so the per-concern modules (command-loop,
// background-tasks, shutdown) take ONE argument.
//
// The shape originated as `CommandLoopDeps`; the split renames it and
// extends with the post-acquire context (graph, registry, identity,
// runtimeRoot) so the same record satisfies every module's needs.

import {
	Effect,
	type Context,
	type Deferred,
	type Exit,
	type Fiber,
	type Queue,
	type Ref,
	type Scope,
	type SubscriptionRef,
} from 'effect';

import type { EngineCommand, EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { SubscribableState } from '../../projection.ts';
import { type ContributionDispatcher } from './contribution-dispatcher.ts';
import { isReadyOrTerminal } from '../lifecycle/index.ts';
import type { LoggerShape } from '../observability/index.ts';
import type { PluginRegistry, ResolvedGraph } from '../lifecycle/index.ts';

/**
 * A long-running background task forked into the supervisor-lifetime
 * scope (snapshot capture, stack restart). The slot holds the live
 * fiber while the task runs and `null` when idle. A second concurrent
 * trigger reads the slot: a non-null slot means one is already running
 * (skip-dedup); a shutdown/conflicting command reads-and-clears the
 * slot and `Fiber.interrupt`s it.
 *
 * The fiber IS the running state, `Effect.forkIn(supervisorScope)` gives
 * it the supervisor's lifetime (so it outlives the command-loop fiber
 * and does NOT wedge shutdown), and `Fiber.interrupt` is the
 * conflict-resolution primitive.
 */
export type BackgroundTaskSlot = Ref.Ref<Fiber.Fiber<void, never> | null>;

export interface SupervisorCommandHandlerContext {
	readonly publish: (event: EngineEvent) => Effect.Effect<void, never, never>;
}

export type SupervisorCommandHandler = (
	cmd: EngineCommand,
	ctx: SupervisorCommandHandlerContext,
) => Effect.Effect<ReadonlyArray<EngineEvent>, unknown, never>;

export interface SupervisorPostAcquireContext {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly identity: Identity;
	readonly runtimeRoot: string;
}

export type SupervisorPostAcquireHook = (
	ctx: SupervisorPostAcquireContext,
) => Effect.Effect<ReadonlyArray<EngineEvent>, unknown, never>;

export interface CommandSubmission {
	readonly command: EngineCommand;
	readonly completion: Deferred.Deferred<Exit.Exit<void, unknown>>;
}

export type QueuedCommand =
	| { readonly kind: 'fire-and-forget'; readonly command: EngineCommand }
	| { readonly kind: 'submitted'; readonly submission: CommandSubmission };

/**
 * True when every node in `graph` has reached a `ready`-or-terminal
 * lifecycle status. Used by the command-loop to gate the post-acquire
 * hook after a (selective) restart and by the initial-acquire path to
 * decide whether to transition the cycle phase to `running`.
 *
 * Failed status reads collapse to `'failed'` so a transient registry
 * error doesn't block the readiness gate forever.
 */
export const allReadyOrTerminal = (
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

/**
 * The shared-state record threaded through command-loop, background
 * tasks, and shutdown. Built once at the top of `startSupervisor`.
 */
export interface SupervisorState {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly ref: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly hub: Queue.Enqueue<EngineEvent>;
	readonly queuedCommands: Queue.Dequeue<QueuedCommand>;
	/** The supervisor-lifetime scope. Long-running background tasks
	 *  (snapshot capture, stack restart) are forked into THIS scope via
	 *  `Effect.forkIn` so they ride the supervisor's lifetime rather than
	 *  the command-loop fiber — a forked capture must not wedge shutdown. */
	readonly supervisorScope: Scope.Scope;
	/** Live stack-restart fiber (or `null` when idle). See {@link BackgroundTaskSlot}.
	 *  Snapshot capture/restore now run INLINE in the command loop (the bounce:
	 *  the handler stops+commits/loads + the loop converges), so there is no
	 *  forked capture fiber — only the stack-restart background task. */
	readonly stackRestartTask: BackgroundTaskSlot;
	readonly shutdownLatch: Ref.Ref<boolean>;
	readonly shutdownComplete: Deferred.Deferred<void>;
	readonly pluginContext: Context.Context<never>;
	readonly dispatcher: ContributionDispatcher;
	readonly logger: LoggerShape;
	readonly identity: Identity;
	readonly runtimeRoot: string;
	readonly commandHandler?: SupervisorCommandHandler;
	readonly postAcquireHook?: SupervisorPostAcquireHook;
}
