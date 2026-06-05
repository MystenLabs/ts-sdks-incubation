// Top-level supervisor entry — composes every per-concern module.
//
// Responsibilities (in order):
//   1. Seed projection identity + booting slice so early-mounted
//      renderers see a complete baseline.
//   2. Resolve the dep graph + boot the registry.
//   3. Build the substrate-wiring bag: logger overlay, runtime root, and
//      the closed contribution dispatcher.
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
	type Fiber,
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
	noopContributionDispatcher,
	type ContributionDispatcher,
} from './contribution-dispatcher.ts';
import {
	Logger,
	LogStore,
	makeLogStore,
	type LoggerShape,
	type LogStoreConfig,
} from '../observability/index.ts';
import { ControlPlaneService } from '../control-plane/service.ts';
import { controlPlaneDomainFromContext } from '../control-plane/domain.ts';
import { RuntimeRoot } from '../paths.ts';
import { declareAccount, setIdentity } from '../projection/update.ts';
import {
	buildWatchIndex,
	exactPrefixMatch,
	installSignalHandler,
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
import {
	allReadyOrTerminal,
	type BackgroundTaskSlot,
	type QueuedCommand,
	type SupervisorCommandHandler,
	type SupervisorPostAcquireHook,
	type SupervisorState,
} from './state.ts';
import type { SupervisedStack } from './types.ts';
import { teardownKeys } from './teardown.ts';
import { plan } from '../reconcile/graph.ts';
import {
	buildTransitionEmitter,
	noopLogger,
	OptionalService,
	setCyclePhase,
	withEventPublishingLogger,
} from './wiring.ts';

const loggerAccess = OptionalService(Logger);
const runtimeRootAccess = OptionalService(RuntimeRoot);

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
	/** Per-service log-store tuning. Absent fields fall back to the
	 *  `DEVSTACK_DASHBOARD_LOG_*` env vars, then the module defaults
	 *  (2000 records/service, 256 services). Threaded into the
	 *  process-scoped `makeLogStore` below. */
	readonly logStore?: LogStoreConfig;
}

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
 * Contribution dispatch: the supervisor replays each plugin's
 * buffered ctx contributions through the closed `dispatcher`
 * (snapshotable/routable/codegenable/projection/strategy-contributor).
 * Production callers pass `buildProductionContributionDispatcher(...)`;
 * bare smoke tests omit it and get the no-op dispatcher.
 */
export const startSupervisor = (
	stack: SupervisedStack,
	identity: Identity,
	state: SubscriptionRef.SubscriptionRef<SubscribableState>,
	pluginContext: Context.Context<never> = Context.empty(),
	dispatcher: ContributionDispatcher = noopContributionDispatcher,
	commandHandler?: SupervisorCommandHandler,
	postAcquireHook?: SupervisorPostAcquireHook,
	options: SupervisorStartupOptions = {},
): Effect.Effect<SupervisorStartup, SupervisorBootError | UnknownDependency, Scope.Scope> =>
	Effect.gen(function* () {
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
		// Background-task fiber slot: the live stack-restart fiber (or `null`
		// when idle). The fiber IS the running state — see `BackgroundTaskSlot`.
		// Forked into `supervisorScope` (below) via `Effect.forkIn`, interrupted
		// via `Fiber.interrupt`. (Snapshot capture/restore run inline in the
		// command loop now — the bounce — so they have no forked slot.)
		const stackRestartTask: BackgroundTaskSlot = yield* Ref.make<Fiber.Fiber<
			void,
			never
		> | null>(null);
		const shutdownLatch = yield* Ref.make(false);
		const shutdownComplete = yield* Deferred.make<void>();
		const initialAcquireStarted = yield* Ref.make(false);

		// Observability store (process-scoped, like `state`/`hub`): a
		// cross-service queryable log ring fed off the SAME logger path that
		// feeds the projection's per-row tail. Survives `stack.restart`
		// because it lives in this closure (only `cycle.id` bumps on restart).
		// The dashboard reads it via the control-plane `domain`.
		const logStore = yield* makeLogStore(options.logStore ?? {});
		const logger = withEventPublishingLogger(baseLogger, state, hub, logStore);

		// The control-plane command verbs, both offering onto the SAME
		// `queuedCommands` seam the single command-loop consumer drains —
		// distinguished only by the QueuedCommand kind:
		//   - `publishCommand` — fire-and-forget; offers a `fire-and-forget`
		//     QueuedCommand and returns immediately.
		//   - `submitCommand` — offers a `submitted` QueuedCommand carrying a
		//     completion deferred, then AWAITs the real exit. So a destructive
		//     command like `snapshot.restore` (which removes live managed
		//     containers then re-acquires) runs in-band with the loop, never
		//     racing the live supervisor out-of-band. Re-fails with the
		//     handler's cause.
		// (Both feed `queuedCommands`, NOT the public `commands` queue + bridge —
		// that queue stays for the signal handler and cross-process callers.)
		const publishCommand = (command: EngineCommand): Effect.Effect<void> =>
			Effect.asVoid(Queue.offer(queuedCommands, { kind: 'fire-and-forget', command }));
		const submitCommand = (command: EngineCommand): Effect.Effect<void, unknown> =>
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
			});

		// Per-plugin scopes parent off the supervisor scope.
		const supervisorScope = yield* Effect.scope;

		const emit = buildTransitionEmitter(state, hub);
		const registry = yield* buildRegistry(graph, supervisorScope, emit);

		// Build the control-plane `domain` accessor surface from the data
		// the supervisor holds at wiring time: the resolved registry +
		// graph, plus the (optional) snapshot orchestrator / container
		// runtime / filesystem the caller may have layered into
		// `pluginContext`. The projection stays CLOSED — `domain` reads
		// resolved plugin VALUES via the name-blind registry seam, never
		// the projection. The registry is process-scoped, so the closure
		// stays valid across `stack.restart` (only `cycle.id` bumps).
		const controlPlaneDomain = controlPlaneDomainFromContext({
			pluginContext,
			graph,
			registry,
			logStore,
		});

		const pluginRuntimeContext = pluginContext.pipe(
			Context.add(Logger, Logger.of(logger)),
			// Observability store. Exposed so the control-plane `domain` can
			// query the cross-service log ring.
			Context.add(LogStore, LogStore.of(logStore)),
			// Expose the control plane (live projection + fire-and-forget
			// command dispatch + the plugin-domain accessor surface) to
			// in-process surfaces like the dashboard plugin. Reads the same
			// `state` ref and `commands` queue the supervisor itself drives.
			Context.add(
				ControlPlaneService,
				ControlPlaneService.of({
					state,
					publishCommand,
					submitCommand,
					domain: controlPlaneDomain,
				}),
			),
		) as Context.Context<never>;

		// Declare a row for every plugin so the projection's
		// `lifecycle.statusChanged` events have a row to attach to.
		// `section` is plugin-declared at `definePlugin({ section })`
		// time; we stamp it onto the row here so the TUI groups rows
		// without pattern-matching on plugin-name substrings.
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
								section: node.member.section,
								endpointSection: node.member.endpointSection ?? node.member.section,
							},
						],
			}));
		}

		// Extract `RuntimeRoot` from the plugin context — recorded on
		// `SupervisorState.runtimeRoot` and read by the post-acquire hook
		// + background tasks (NOT threaded into the acquire path, which is
		// name-blind). Fallback to '' for bare smoke tests that don't wire
		// RuntimeRoot; emit a logWarning when that path fires so
		// production-style misconfigurations are visible (plugins computing
		// `${runtimeRoot}/foo` would otherwise silently resolve to
		// host-filesystem root).
		const runtimeRootResolved = runtimeRootAccess.read(pluginContext, { root: '' });
		if (runtimeRootResolved.root === '') {
			yield* Effect.logWarning(
				'supervisor: RuntimeRoot missing from pluginContext; falling back to empty root. ' +
					'Production wiring must layer `layerRuntimeRoot(...)` into pluginContext.',
			);
		}
		const runtimeRoot = runtimeRootResolved.root;

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
			supervisorScope,
			stackRestartTask,
			shutdownLatch,
			shutdownComplete,
			pluginContext: pluginRuntimeContext,
			dispatcher,
			logger,
			identity,
			runtimeRoot,
			commandHandler,
			postAcquireHook,
		};

		const runInitialAcquire = Effect.gen(function* () {
			const alreadyStarted = yield* Ref.modify(initialAcquireStarted, (started) => [started, true]);
			if (alreadyStarted) return;
			if (yield* Ref.get(shutdownLatch)) return;
			yield* acquireFullGraph(
				graph,
				registry,
				state,
				hub,
				pluginRuntimeContext,
				dispatcher,
				logger,
				identity,
				supervisorScope,
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
		});

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
				// One `selective-restart.requested` per matched plugin, in
				// match order. (Previously the head was offered separately
				// from the tail — identical behaviour, one fewer branch.)
				for (const key of matched) {
					yield* Queue.offer(commands, {
						tag: 'selective-restart.requested',
						pluginKey: key,
					} satisfies EngineCommand);
				}
			});

		// Fork the command loop.
		if (enableCommandLoop) {
			yield* Effect.forkScoped(commandLoop(supervisorState));
		}

		// Tear-down finalizer: closes every plugin scope in reverse-dep
		// order. The supervisor scope itself closes when the surrounding
		// caller closes — `Scope.close` cascades to plugin scopes.
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const fullDrain = plan(graph, {
					kind: 'graph-keys',
					keys: [...graph.nodes.keys()],
				});
				yield* teardownKeys(graph, registry, fullDrain.teardownOrder).pipe(
					Effect.catch(() => Effect.void),
				);
			}),
		);

		const awaitShutdown: Effect.Effect<void> = Deferred.await(shutdownComplete);

		// The programmable `runCommand` surface is exactly the submit-and-await
		// path the control plane uses; share the one implementation.
		const runCommand = submitCommand;

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
	});

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
	dispatcher: ContributionDispatcher = noopContributionDispatcher,
	commandHandler?: SupervisorCommandHandler,
	postAcquireHook?: SupervisorPostAcquireHook,
): Effect.Effect<SupervisorHandle, SupervisorError, Scope.Scope> =>
	Effect.gen(function* () {
		const startup = yield* startSupervisor(
			stack,
			identity,
			state,
			pluginContext,
			dispatcher,
			commandHandler,
			postAcquireHook,
			{ commandLoop: true },
		);
		yield* startup.runInitialAcquire;
		return startup.handle;
	});

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
	});
