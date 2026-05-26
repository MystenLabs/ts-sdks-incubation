// Top-level supervisor entry — composes every per-concern module.
//
// Responsibilities (in order):
//   1. Seed projection identity + booting slice so early-mounted
//      renderers see a complete baseline.
//   2. Resolve the dep graph + boot the registry.
//   3. Build the substrate-wiring bag: logger overlay, runtime root,
//      CapabilitySinks service (caller-pre-built or substrate-default).
//   4. Compose the `SupervisorState` record (one bag passed to every
//      module).
//   5. Build `runInitialAcquire` — the deferred initial-acquire body.
//   6. Build the watch index + `notifyWatchFire`.
//   7. Fork the command loop + signal handler.
//   8. Install the scope-close finalizer (reverse-dep teardown).
//   9. Return the handle.

import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Queue,
	Ref,
	Scope,
	SubscriptionRef,
} from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineCommand, EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { AccountProjection, SubscribableState } from '../../projection.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinksDefault,
	type OrchestratorSinks,
} from '../capability-sinks/index.ts';
import { Logger, withStackSpan, type LoggerShape } from '../observability/index.ts';
import { RuntimeRoot } from '../paths.ts';
import { declareAccount, setIdentity } from '../projection/update.ts';
import {
	buildWatchIndex,
	exactPrefixMatch,
	installSignalHandler,
	isReadyOrTerminal,
	planFullDrain,
	resolveGraph,
	type PluginRegistry,
	type ResolvedGraph,
	type UnknownDependency,
	type WatchEntry,
} from '../lifecycle/index.ts';
import { acquireFullGraph, buildRegistry } from './acquire-node.ts';
import { commandLoop } from './command-loop.ts';
import { runPostAcquireHook } from './background-tasks.ts';
import {
	SupervisorBootError,
	type SupervisorError,
	type SupervisorPostAcquireFailed,
} from './errors.ts';
import type {
	QueuedCommand,
	SnapshotCaptureTaskState,
	StackRestartTaskState,
	SupervisorCommandHandler,
	SupervisorPostAcquireHook,
	SupervisorState,
} from './state.ts';
import type { SupervisedStack } from './types.ts';
import { teardownKeys } from './teardown.ts';
import {
	buildTransitionEmitter,
	noopLogger,
	OptionalService,
	setCyclePhase,
	withEventPublishingLogger,
} from './wiring.ts';

const loggerAccess = OptionalService(Logger);
const runtimeRootAccess = OptionalService(RuntimeRoot);
const sinksAccess = OptionalService(CapabilitySinksService);

export interface SupervisorHandle {
	readonly identity: Identity;
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly events: Queue.Dequeue<EngineEvent>;
	readonly commands: Queue.Enqueue<EngineCommand>;
	readonly runCommand: (command: EngineCommand) => Effect.Effect<void, unknown>;
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly watchIndex: ReadonlyArray<WatchEntry>;
	/** Fire a watch event for the given path. Substrate-level glue:
	 *  the thick L0 watcher calls this; tests call it directly. */
	readonly notifyWatchFire: (path: string) => Effect.Effect<void>;
	/** Block until the supervisor's command loop sets the shutdown
	 *  latch. The outer runtime then closes the supervisor scope, which
	 *  tears down every plugin in reverse-dep order. */
	readonly awaitShutdown: Effect.Effect<void>;
}

export interface SupervisorStartup {
	readonly handle: SupervisorHandle;
	readonly runInitialAcquire: Effect.Effect<void, SupervisorPostAcquireFailed, never>;
}

export interface SupervisorStartupOptions {
	readonly commandLoop?: boolean;
}

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

const pendingAccountProjection = (
	rowKey: PluginKey,
	resourceId: string,
	updatedAt: number,
): AccountProjection | null => {
	if (!resourceId.startsWith('account/')) return null;
	const name = resourceId.slice('account/'.length);
	if (name.length === 0) return null;
	return {
		key: resourceId as `account/${string}`,
		rowKey,
		name,
		address: null,
		scheme: null,
		source: null,
		funding: { status: 'pending', balanceMist: null, requestedMist: null, entries: [] },
		walletVisible: false,
		updatedAt,
	};
};

/**
 * Prepare a supervisor for `stack` without running the initial acquire.
 * The returned `SupervisorHandle` is Scope-managed; the supervisor's
 * lifecycle is the surrounding Scope's lifecycle. Signal handlers,
 * the command loop, and every plugin's scope are children of the
 * supervisor scope. Callers that mount renderers can subscribe to the
 * returned state before invoking `runInitialAcquire`.
 *
 * `pluginContext` carries the substrate-context services available to
 * each plugin's `acquire` body (`IdentityContext`,
 * `ContainerRuntimeService`, `RuntimeRoot`, `StackPathsService`, etc.).
 * Plugins declare what they need by yielding the corresponding
 * `Context.Service` tag from within `Effect.gen`; the supervisor
 * provides this context before running the acquire effect so the
 * plugin's R-channel narrows to `Scope.Scope` (then to `never` after
 * the per-plugin Scope is provided).
 *
 * `CapabilitySinksService` extension (ARCHITECTURE.md § Plugin-author
 * extension via Layer composition): if the caller layers a
 * `CapabilitySinksService` into `pluginContext`, the supervisor
 * harvests through THAT instance instead of building its own.
 */
export const startSupervisor = (
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<SubscribableState>,
	pluginContext: Context.Context<never> = Context.empty(),
	sinks: OrchestratorSinks = [],
	commandHandler?: SupervisorCommandHandler,
	postAcquireHook?: SupervisorPostAcquireHook,
	options: SupervisorStartupOptions = {},
): Effect.Effect<SupervisorStartup, SupervisorBootError | UnknownDependency, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'devstack.stack.memberCount': stack.members.length,
		});

		// Optional Logger service — pull from the plugin context if the
		// caller layered it in (CLI / e2e do). Bare smoke tests get the
		// no-op fallback so they remain log-free.
		const baseLogger: LoggerShape = loggerAccess.read(pluginContext, noopLogger);

		yield* baseLogger.log('supervisor', null, {
			level: 'debug',
			message: 'supervisor boot start',
			fields: {
				app: identity.app,
				stack: identity.stack,
				network: identity.chain,
				memberCount: stack.members.length,
			},
		});

		// Seed the projection's identity and booting slices before
		// acquire starts so renderers mounting early have a complete
		// baseline.
		yield* SubscriptionRef.update(
			state,
			(s) =>
				({
					...setIdentity(s, {
						app: identity.app,
						stack: identity.stack,
						network: identity.chain,
					}),
					cycle: {
						...s.cycle,
						startedAt: s.cycle.startedAt === 0 ? Date.now() : s.cycle.startedAt,
						phase: 'booting',
					},
				}) satisfies SubscribableState,
		);

		// Resolve the dep graph.
		const graph = yield* resolveGraph(stack.members).pipe(
			Effect.mapError((cause) => new SupervisorBootError({ cause })),
		);

		// Event hub + command channel.
		const hub = yield* Queue.unbounded<EngineEvent>();
		const commands = yield* Queue.unbounded<EngineCommand>();
		const queuedCommands = yield* Queue.unbounded<QueuedCommand>();
		const stackRestartTask = yield* Ref.make<StackRestartTaskState>({ tag: 'idle' });
		const stackRestartSeq = yield* Ref.make(0);
		const snapshotCaptureTask = yield* Ref.make<SnapshotCaptureTaskState>({ tag: 'idle' });
		const snapshotCaptureSeq = yield* Ref.make(0);
		const shutdownLatch = yield* Ref.make(false);
		const shutdownComplete = yield* Deferred.make<void>();
		const initialAcquireStarted = yield* Ref.make(false);
		const logger = withEventPublishingLogger(baseLogger, state, hub);
		const pluginRuntimeContext = pluginContext.pipe(
			Context.add(Logger, Logger.of(logger)),
		) as Context.Context<never>;

		// Per-plugin scopes parent off the supervisor scope.
		const supervisorScope = yield* Effect.scope;

		const emit = buildTransitionEmitter(state, hub);
		const registry = yield* buildRegistry(graph, supervisorScope, emit);

		// Declare a row for every plugin so the projection's
		// `lifecycle.statusChanged` events have a row to attach to.
		for (const [key, node] of graph.nodes) {
			const declaredAccount = pendingAccountProjection(key, node.member.id, Date.now());
			yield* SubscriptionRef.update(state, (s) => ({
				...(declaredAccount === null ? s : declareAccount(s, declaredAccount)),
				rows: s.rows.some((r) => r.key === key)
					? s.rows
					: [
							...s.rows,
							{
								key,
								role: node.member.role,
								status: 'pending' as LifecycleStatus,
								phase: null,
								lastError: null,
								logTail: { lines: [], level: 'info' as const, truncated: false },
								endpoints: [],
								selectiveRestartHighlight: false,
							},
						],
			}));
		}

		// Extract `RuntimeRoot` from the plugin context — needed to
		// build the `AcquireContext` handed to dynamic capability
		// factories. Fallback to '' if the caller didn't add `RuntimeRoot`
		// to the plugin context (bare smoke tests).
		const runtimeRoot = runtimeRootAccess.read(pluginContext, { root: '' }).root;

		// Resolve the CapabilitySinks registry for this stack. Two paths:
		//
		//   (a) Plugin-author / orchestrator pre-built path: the caller
		//       layered a `CapabilitySinksService` into `pluginContext`
		//       (typically by composing `layerCapabilitySinksDefault(...)`
		//       PLUS one or more custom-sink Layers). The supervisor
		//       harvests through THAT instance, so custom sinks
		//       registered by plugin authors actually fire.
		//
		//   (b) Bare path: no service in context — the supervisor builds
		//       the substrate default with the orchestrator sinks passed
		//       in. `Layer.build` opens the layer's resources on the
		//       SURROUNDING scope (the supervisor's), so the sinks +
		//       formatter registry live for the supervisor's lifetime
		//       and reap on its scope close.
		const sinksService = yield* sinksAccess.readEffect(
			pluginRuntimeContext,
			Effect.gen(function* () {
				return Context.get(
					yield* Layer.build(layerCapabilitySinksDefault(sinks)),
					CapabilitySinksService,
				);
			}),
		);

		const enableCommandLoop = options.commandLoop !== false;
		if (enableCommandLoop) {
			yield* Effect.forkScoped(installSignalHandler(commands));
			yield* Effect.forkScoped(
				Effect.gen(function* () {
					while (true) {
						const command = yield* Queue.take(commands);
						yield* Queue.offer(queuedCommands, { kind: 'fire-and-forget', command });
					}
				}),
			);
		}

		const supervisorState: SupervisorState = {
			graph,
			registry,
			ref: state,
			hub,
			queuedCommands,
			stackRestartTask,
			stackRestartSeq,
			snapshotCaptureTask,
			snapshotCaptureSeq,
			shutdownLatch,
			shutdownComplete,
			pluginContext: pluginRuntimeContext,
			sinks: sinksService,
			logger,
			identity,
			runtimeRoot,
			parentScope: supervisorScope,
			commandHandler,
			postAcquireHook,
		};

		const runInitialAcquire = Effect.gen(function* () {
			const alreadyStarted = yield* Ref.modify(initialAcquireStarted, (started) => [
				started,
				true,
			]);
			if (alreadyStarted) return;
			if (yield* Ref.get(shutdownLatch)) return;
			yield* acquireFullGraph(
				graph,
				registry,
				state,
				hub,
				pluginRuntimeContext,
				sinksService,
				logger,
				identity,
				runtimeRoot,
			);
			if (yield* Ref.get(shutdownLatch)) return;
			const initialReady = yield* allReadyOrTerminal(graph, registry);
			if (initialReady) {
				yield* runPostAcquireHook(supervisorState);
				if (!(yield* Ref.get(shutdownLatch))) {
					yield* setCyclePhase(state, 'running');
				}
			} else if (!(yield* Ref.get(shutdownLatch))) {
				yield* setCyclePhase(state, 'running');
			}
		}).pipe(Effect.withSpan('lifecycle.supervisor.initialAcquire'));

		// Build the watch index up front; the supervisor exposes
		// `notifyWatchFire` so the L0 thick watcher can call into it.
		const watchIndex = buildWatchIndex(graph.nodes);

		const notifyWatchFire = (path: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const matched = new Set<PluginKey>();
				for (const entry of watchIndex) {
					for (const pat of entry.paths) {
						if (exactPrefixMatch(pat, path)) {
							matched.add(entry.pluginKey);
							break;
						}
					}
				}
				if (matched.size === 0) return;
				yield* Queue.offer(commands, {
					tag: 'selective-restart.requested',
					pluginKey: [...matched][0]!,
				} satisfies EngineCommand);
				const rest = [...matched].slice(1);
				for (const key of rest) {
					yield* Queue.offer(commands, {
						tag: 'selective-restart.requested',
						pluginKey: key,
					} satisfies EngineCommand);
				}
			}).pipe(Effect.withSpan('lifecycle.supervisor.notifyWatchFire'));

		// Fork the command loop.
		if (enableCommandLoop) {
			yield* Effect.forkScoped(commandLoop(supervisorState));
		}

		// Tear-down finalizer: closes every plugin scope in reverse-dep
		// order. The supervisor scope itself closes when the surrounding
		// caller closes — `Scope.close` cascades to plugin scopes.
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const plan = planFullDrain(graph);
				yield* teardownKeys(graph, registry, plan.teardownOrder).pipe(
					Effect.catch(() => Effect.void),
				);
			}),
		);

		const awaitShutdown: Effect.Effect<void> = Deferred.await(shutdownComplete).pipe(
			Effect.withSpan('lifecycle.supervisor.awaitShutdown'),
		);

		const runCommand = (command: EngineCommand): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				const completion = yield* Deferred.make<Exit.Exit<void, unknown>>();
				yield* Queue.offer(queuedCommands, {
					kind: 'submitted',
					submission: { command, completion },
				});
				const exit = yield* Deferred.await(completion);
				if (Exit.isFailure(exit)) {
					return yield* Effect.failCause(exit.cause);
				}
			}).pipe(Effect.withSpan('lifecycle.supervisor.runCommand'));

		const handle = {
			identity,
			graph,
			registry,
			events: hub,
			commands,
			runCommand,
			state,
			watchIndex,
			notifyWatchFire,
			awaitShutdown,
		} satisfies SupervisorHandle;
		return { handle, runInitialAcquire } satisfies SupervisorStartup;
	}).pipe(
		withStackSpan('lifecycle.supervisor.startSupervisor', {
			app: identity.app,
			stack: identity.stack,
			network: identity.chain,
		}),
	);

/**
 * Boot a supervisor for `stack` and wait for the initial acquire to
 * finish before returning the handle. Existing callers that only need
 * a ready-or-failed handle keep this simpler entry point; live surfaces
 * that need startup display use `startSupervisor`.
 */
export const supervise = (
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<SubscribableState>,
	pluginContext: Context.Context<never> = Context.empty(),
	sinks: OrchestratorSinks = [],
	commandHandler?: SupervisorCommandHandler,
	postAcquireHook?: SupervisorPostAcquireHook,
): Effect.Effect<SupervisorHandle, SupervisorError, Scope.Scope> =>
	Effect.gen(function* () {
		const startup = yield* startSupervisor(
			stack,
			identity,
			state,
			pluginContext,
			sinks,
			commandHandler,
			postAcquireHook,
			{ commandLoop: true },
		);
		yield* startup.runInitialAcquire;
		return startup.handle;
	}).pipe(
		withStackSpan('lifecycle.supervisor.supervise', {
			app: identity.app,
			stack: identity.stack,
			network: identity.chain,
		}),
	);

/**
 * Block until the supervisor's shutdown latch fires OR the surrounding
 * scope is interrupted (signal-driven exit). Wraps `awaitShutdown` for
 * the common "boot then wait" shape.
 *
 * Returns the final supervisor state so callers (CLI, programmable
 * API) can inspect the projection after shutdown.
 */
export const runToShutdown = (
	handle: SupervisorHandle,
): Effect.Effect<SubscribableState, never, never> =>
	Effect.gen(function* () {
		yield* handle.awaitShutdown;
		return yield* SubscriptionRef.get(handle.state);
	}).pipe(Effect.withSpan('lifecycle.supervisor.runToShutdown'));
