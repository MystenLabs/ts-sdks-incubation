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

import type {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Ref,
	Scope,
	SubscriptionRef,
} from 'effect';

import type { EngineCommand, EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { SubscribableState } from '../../projection.ts';
import { type CapabilitySinksShape } from '../capability-sinks/index.ts';
import type { LoggerShape } from '../observability/index.ts';
import type {
	PluginRegistry,
	ResolvedGraph,
} from '../lifecycle/index.ts';

export type StackRestartTaskState =
	| { readonly tag: 'idle' }
	| { readonly tag: 'starting'; readonly token: number }
	| {
			readonly tag: 'running';
			readonly token: number;
			readonly fiber: Fiber.Fiber<void, never>;
	  };

export type SnapshotCaptureTaskState =
	| { readonly tag: 'idle' }
	| { readonly tag: 'starting'; readonly token: number; readonly snapshotId: string | null }
	| {
			readonly tag: 'running';
			readonly token: number;
			readonly snapshotId: string | null;
			readonly fiber: Fiber.Fiber<void, never>;
	  };

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
 * The shared-state record threaded through command-loop, background
 * tasks, and shutdown. Built once at the top of `startSupervisor`.
 */
export interface SupervisorState {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly ref: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly hub: Queue.Enqueue<EngineEvent>;
	readonly queuedCommands: Queue.Dequeue<QueuedCommand>;
	readonly stackRestartTask: Ref.Ref<StackRestartTaskState>;
	readonly stackRestartSeq: Ref.Ref<number>;
	readonly snapshotCaptureTask: Ref.Ref<SnapshotCaptureTaskState>;
	readonly snapshotCaptureSeq: Ref.Ref<number>;
	readonly shutdownLatch: Ref.Ref<boolean>;
	readonly shutdownComplete: Deferred.Deferred<void>;
	readonly pluginContext: Context.Context<never>;
	readonly sinks: CapabilitySinksShape;
	readonly logger: LoggerShape;
	readonly identity: Identity;
	readonly runtimeRoot: string;
	readonly parentScope: Scope.Scope;
	readonly commandHandler?: SupervisorCommandHandler;
	readonly postAcquireHook?: SupervisorPostAcquireHook;
}
