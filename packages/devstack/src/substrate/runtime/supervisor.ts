// Stack supervisor — the substrate's orchestrator.
//
// Architecture § Engine / supervisor split:
//   "Stack supervisor (L0): the outer driver — boot identity, consult
//   network resolver, run scheduler, fire shutdown finalizers, emit
//   lifecycle events."
//
// Responsibilities:
//   - Resolve the plugin graph from a `Stack` value.
//   - Start plugins in dep order; each plugin's `start` runs under
//     its own Scope; ready-gate awaits its start effect.
//   - Maintain the per-plugin lifecycle state machine.
//   - Emit typed `EngineEvent`s onto the projection ref + event hub.
//   - Watch invalidation → selective restart through the dep-graph
//     closure planner.
//   - SIGINT/SIGTERM → graceful drain; second signal escalates to abort.
//   - Restart / drain / shutdown commands on the command stream.

// What's explicitly NOT here:
//   - The thick watcher (L0 primitive — separate module).
//   - The cause walker / cascade formatter (shared between supervisor
//     and renderer, lives under `observability/`).
//   - Cache eviction / strategy-registry mutation (separate modules).
//   - Container runtime (L1 adapter; supervisor doesn't know docker).

import {
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Scope,
	SubscriptionRef,
} from 'effect';

import type { CapabilityDecl } from '../../contracts/capability-decl.ts';
import type {
	StrategyContributorDecl,
	StrategyRegistry,
} from '../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../brand.ts';
import type { EngineCommand, EngineEvent } from '../events.ts';
import type { Identity } from '../identity.ts';
import type { LifecycleStatus, PluginRole } from '../lifecycle.ts';
import type { DevstackOptions } from '../options.ts';
import {
	resolvePluginDependencies,
	type AcquireContext,
	type AnyPlugin,
	type PluginErrorContribution,
} from '../plugin.ts';
import type { AccountProjection, SubscribableState } from '../projection.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinksDefault,
	type AnyContribution,
	type CapabilitySinksShape,
	type HarvestContext,
	type OrchestratorSinks,
} from './capability-sinks/index.ts';
import { CurrentPluginKey, CurrentPluginProgress } from './current-plugin.ts';
import {
	Logger,
	type LoggerShape,
	withPluginSpan,
	withStackSpan,
	annotatePhase,
	annotateOp,
	prettyErrorStructured,
} from './observability/index.ts';
import { PostAcquireTaskFailed } from './post-acquire-tasks.ts';
import { RuntimeRoot } from './paths.ts';
import { getOrDefault, getOrDefaultEffect } from './context-helpers.ts';
import { operationalEndpointEventsFromResolvedValue } from './projection/operational-endpoints.ts';
import { declareAccount, setIdentity, updateRef } from './projection/update.ts';
import {
	awaitUpstreams,
	buildDependencyReaderFor,
	buildWatchIndex,
	exactPrefixMatch,
	installSignalHandler,
	isReadyOrTerminal,
	makeEntry,
	makeRegistry,
	planFullDrain,
	planRestart,
	resolveGraph,
	type DepGraphError,
	type PluginAcquireFailed,
	type PluginEntry,
	type PluginRegistry,
	type ResolvedGraph,
	type RestartTargetMissing,
	type UnknownDependency,
	type WatchEntry,
} from './lifecycle/index.ts';
import { StrategyRegistryService } from './strategy-registry/service.ts';

// -----------------------------------------------------------------------------
// Public Stack shape (mirror — `define-devstack.ts` exports)
// -----------------------------------------------------------------------------

/** Minimum surface the supervisor reads off a `Stack`. The full
 *  `Stack<Members>` shape lives in `api/define-devstack.ts` and carries
 *  type-level provenance — at the runtime boundary the supervisor only
 *  needs the erased plugin list + options. */
export interface SupervisedStack {
	readonly _tag: 'Stack';
	readonly members: ReadonlyArray<AnyPlugin>;
	readonly options: DevstackOptions;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class SupervisorBootError extends Data.TaggedError('SupervisorBootError')<{
	readonly cause: DepGraphError;
}> {}

export class SupervisorPostAcquireFailed extends Data.TaggedError('SupervisorPostAcquireFailed')<{
	readonly cause: Cause.Cause<unknown>;
}> {}

export class CapabilityFactoryFailed extends Data.TaggedError('CapabilityFactoryFailed')<{
	readonly pluginKey: PluginKey;
	readonly message: string;
	readonly cause: unknown;
}> {}

/** Fallback used when the supervisor's `pluginContext` doesn't carry a
 *  Logger service. Swallows every line — the trade-off is that bare
 *  `supervise()` smoke tests stay log-free, while the wired CLI / e2e
 *  layer stack picks up the real Logger. */
const noopLogger: LoggerShape = {
	log: () => Effect.void,
	readTag: () => Effect.succeed({ lines: [], truncated: false }),
	readAll: Effect.succeed(new Map()),
	clearTag: () => Effect.void,
};

const projectionLevel = (
	level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
): Extract<EngineEvent, { tag: 'log.appended' }>['level'] | null => {
	switch (level) {
		case 'trace':
		case 'debug':
			return null;
		case 'info':
			return 'info';
		case 'warn':
			return 'warn';
		case 'error':
		case 'fatal':
			return 'error';
		default: {
			const _exhaustive: never = level;
			void _exhaustive;
			return 'info';
		}
	}
};

const withEventPublishingLogger = (
	base: LoggerShape,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
): LoggerShape => ({
	...base,
	log: (tag, pluginKey, payload) =>
		Effect.gen(function* () {
			yield* base.log(tag, pluginKey, payload);
			if (pluginKey === null) return;
			const level = projectionLevel(payload.level);
			if (level === null) return;
			yield* publish(ref, hub, {
				tag: 'log.appended',
				pluginKey,
				line: payload.message,
				level,
				at: Date.now(),
			});
		}),
});

export type SupervisorError =
	| SupervisorBootError
	| SupervisorPostAcquireFailed
	| CapabilityFactoryFailed
	| PluginAcquireFailed
	| RestartTargetMissing
	| UnknownDependency;

const noopStrategyRegistry: StrategyRegistry = {
	get: (key) =>
		Effect.fail({
			_tag: 'StrategyNotFoundError',
			capabilityKey: key,
			registeredKeys: [],
		}),
	list: () => Effect.succeed([]),
	register: () => Effect.void,
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

// -----------------------------------------------------------------------------
// Event publishing
// -----------------------------------------------------------------------------

/** Publishing helper: writes the event to the projection ref AND
 *  enqueues it onto the live event hub for renderers that subscribe to
 *  the raw stream. */
const publish = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	event: EngineEvent,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* updateRef(ref, event);
		yield* Queue.offer(hub, event);
	});

const setCyclePhase = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	phase: SubscribableState['cycle']['phase'],
): Effect.Effect<void> =>
	SubscriptionRef.update(ref, (state) => ({
		...state,
		cycle: {
			...state.cycle,
			startedAt: state.cycle.startedAt === 0 ? Date.now() : state.cycle.startedAt,
			phase,
		},
	}));

/** Build the registry's `onTransition` callback — turns status changes
 *  into typed events. */
const buildTransitionEmitter =
	(
		ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
		hub: Queue.Enqueue<EngineEvent>,
	): ((key: PluginKey, from: LifecycleStatus, to: LifecycleStatus) => Effect.Effect<void>) =>
	(key, from, to) =>
		publish(ref, hub, {
			tag: 'lifecycle.statusChanged',
			pluginKey: key,
			from,
			to,
			at: Date.now(),
		});

// -----------------------------------------------------------------------------
// Boot the registry from a graph
// -----------------------------------------------------------------------------

const buildRegistry = (
	graph: ResolvedGraph,
	parentScope: Scope.Scope,
	emit: (key: PluginKey, from: LifecycleStatus, to: LifecycleStatus) => Effect.Effect<void>,
): Effect.Effect<PluginRegistry, never, never> =>
	Effect.gen(function* () {
		const entries = new Map<PluginKey, PluginEntry>();
		for (const [key, node] of graph.nodes) {
			const entry = yield* makeEntry(node, parentScope);
			entries.set(key, entry);
		}
		return makeRegistry(entries, emit);
	});

// -----------------------------------------------------------------------------
// Capability sinks — orchestrator registration callbacks
// -----------------------------------------------------------------------------
//
// The substrate-name-blind kind→sink registry lives in
// `capability-sinks/`. The supervisor accepts an `OrchestratorSinks`
// bag (the L3 orchestrator's callbacks) and the substrate composes it
// into the `CapabilitySinksService` Layer that backs the harvest loop.
// `OrchestratorSinks` is re-exported from this module so existing
// callers (CLI, e2e tests) keep their import paths.

export type { OrchestratorSinks } from './capability-sinks/index.ts';

/**
 * Resolve a plugin's `capabilities` field to a concrete decl tuple.
 *
 * Two accepted shapes (see `Plugin.capabilities` for the
 * authoring-side contract):
 *
 *   (a) Static — a plain `ReadonlyArray<CapabilityDecl>`. Returned
 *       as-is.
 *
 *   (b) Dynamic — a `CapabilitiesFactory<…>` function. Invoked with
 *       the resolved plugin value + the acquire context built from
 *       the supervisor's identity + runtime root. The function is
 *       called once per acquire (post-success); the returned tuple
 *       flows into `dispatchContributions` like a static one.
 *
 * The dynamic seam exists so plugins' snapshot subtrees, codegen
 * bindings, routable URLs, strategy contributions, etc. can stamp
 * the REAL chain id / package id / network alias produced by their
 * acquire body, instead of the factory-time placeholder strings the
 * static form forces.
 *
 * The substrate stays generic: this resolver doesn't know any
 * service name; the discrimination is purely structural
 * (`typeof === 'function'`).
 */
const resolveCapabilities = (
	pluginKey: PluginKey,
	field:
		| ReadonlyArray<CapabilityDecl>
		| ((resolved: unknown, ctx: AcquireContext) => ReadonlyArray<CapabilityDecl>)
		| undefined,
	resolved: unknown,
	acquireContext: AcquireContext,
): Effect.Effect<ReadonlyArray<CapabilityDecl>, CapabilityFactoryFailed> => {
	if (field === undefined) return Effect.succeed([]);
	if (typeof field === 'function') {
		return Effect.try({
			try: () => field(resolved, acquireContext),
			catch: (cause) =>
				new CapabilityFactoryFailed({
					pluginKey,
					message: `capability factory failed for ${pluginKey}`,
					cause,
				}),
		});
	}
	return Effect.succeed(field);
};

/**
 * Walk a plugin's `capabilities` tuple + `errorContributions` after a
 * successful acquire, route every contribution through the
 * substrate-owned `CapabilitySinksService`. The plugin's scope is
 * provided so each sink's `addFinalizer` lands on the plugin's scope —
 * registrations reap on selective-restart / shutdown.
 *
 * The supervisor stays kind-blind: it builds the contribution union
 * (`{source: 'capability'|'error', ...}`) and the dispatch happens
 * inside the service. Unknown kinds are downgraded to no-ops here so
 * the substrate-open-by-default contract holds — plugin authors can
 * emit a custom-kind decl that is observed only by the orchestrators
 * that registered the matching sink.
 */
const dispatchContributions = (
	pluginKey: PluginKey,
	capabilities: ReadonlyArray<CapabilityDecl>,
	errorContributions: ReadonlyArray<PluginErrorContribution>,
	pluginRole: PluginRole,
	identity: Identity,
	pluginContext: Context.Context<never>,
	pluginScope: Scope.Scope,
	sinks: CapabilitySinksShape,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
): Effect.Effect<void, unknown, never> =>
	Effect.gen(function* () {
		const strategyRegistry = getOrDefault(
			pluginContext,
			StrategyRegistryService,
			noopStrategyRegistry,
		);
		const harvestCtx: HarvestContext = {
			pluginKey,
			identity,
			publish: (event) => publish(ref, hub, event),
			registerStrategy: (decl: StrategyContributorDecl<string, unknown>) =>
				strategyRegistry.register(decl.capabilityKey, decl.strategy, {
					autoMounted: decl.autoMounted,
					...(decl.priority === undefined ? {} : { priority: decl.priority }),
				}),
		};

		const items: ReadonlyArray<AnyContribution> = [
			...capabilities.map<AnyContribution>((decl) => ({
				source: 'capability',
				decl,
			})),
			...errorContributions.map<AnyContribution>((contribution) => ({
				source: 'error',
				contribution,
			})),
		];

		for (const item of items) {
			const dispatch = sinks
				.dispatch(item, harvestCtx)
				.pipe(Effect.catchTag('UnknownContributionKind', () => Effect.void));
			yield* Scope.provide(dispatch, pluginScope);
		}
	}).pipe(
		withPluginSpan('lifecycle.supervisor.dispatchContributions', {
			app: identity.app,
			stack: identity.stack,
			network: identity.chain,
			pluginKey,
			role: pluginRole,
		}),
	);

// -----------------------------------------------------------------------------
// Acquire one node
// -----------------------------------------------------------------------------

/**
 * Run one node's `start` under its own scope. Steps:
 *  1. Transition `pending → acquiring` (publishes the event).
 *  2. Await upstreams (their ready-gates).
 *  3. Build resolved dependency values from declared resource refs.
 *  4. Run the plugin's `start` Effect inside the entry's Scope,
 *     after providing the substrate-context services bundle so the
 *     plugin's R-channel yields (`IdentityContext`,
 *     `ContainerRuntimeService`, etc.) resolve to live instances.
 *  5. On success: stash the resolved value + `markReady` (publishes
 *     the `ready` transition).
 *  6. On failure: `markFailed` (publishes the `failed` transition, fails
 *     the deferred so downstream consumers short-circuit).
 *
 * Errors are caught and stashed onto the registry entry — the outer
 * scheduler doesn't propagate per-plugin failures; ready-gate failure
 * propagation handles the downstream blocking. The supervisor's outer
 * fiber surfaces the union via `Fiber.join` when the user asks for
 * "stack ready or err".
 */
const acquireNode = (
	registry: PluginRegistry,
	key: PluginKey,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const entry = registry.entries.get(key);
		if (entry === undefined) return;
		yield* annotatePhase('acquire');
		yield* logger.log(`supervisor/${key}`, key, {
			level: 'debug',
			message: 'plugin acquire start',
			fields: { role: entry.node.member.role },
		});
		yield* registry.transition(key, 'acquiring').pipe(Effect.catch(() => Effect.void));
		// Wait for upstreams. If any failed, mark this one failed too —
		// the cause walker carries the upstream's `PluginAcquireFailed`.
		const upstreamWait = awaitUpstreams(registry, entry.node).pipe(
			Effect.matchEffect({
				onFailure: (cause) =>
					Effect.gen(function* () {
						yield* registry.markFailed(key, cause).pipe(Effect.catch(() => Effect.void));
						return false as const;
					}),
				onSuccess: () => Effect.succeed(true as const),
			}),
		);
		const ok = yield* upstreamWait;
		if (ok !== true) {
			yield* logger.log(`supervisor/${key}`, key, {
				level: 'warn',
				message: 'plugin acquire skipped — upstream failed',
			});
			return;
		}
		// Build resolved dependency values over the registry's resolved
		// values, then run the plugin's `start` against the entry's
		// Scope via `Scope.provide` — provides the scope to the acquire
		// effect's requirements WITHOUT closing it (unlike `Scope.use`,
		// which closes on exit). Finalizers stay registered on the
		// entry's scope; the supervisor closes the scope explicitly in
		// `teardownNode`.
		//
		// `Effect.provide(pluginContext)` injects the substrate-context
		// services the plugin's acquire body yields (Identity,
		// ContainerRuntime, etc.). The plugin's R channel narrows from
		// the per-plugin union to `Scope.Scope` once these are provided;
		// `Scope.provide` then absorbs the scope itself. After both,
		// R = never — safe to run inside the supervisor's `never` fiber.
		const readDependency = buildDependencyReaderFor(registry, entry.node);
		const deps = resolvePluginDependencies(entry.node.member, readDependency);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const start = entry.node.member.start as (
			deps: unknown,
		) => Effect.Effect<unknown, unknown, any>;
		const currentPluginContext = pluginContext.pipe(
			Context.add(CurrentPluginKey, { key }),
			Context.add(CurrentPluginProgress, {
				setPhase: (phase) =>
					publish(ref, hub, {
						tag: 'lifecycle.phaseSet',
						pluginKey: key,
						phase,
						at: Date.now(),
					}),
			}),
		);
		const providedAcquire = Effect.provide(start(deps), currentPluginContext) as Effect.Effect<
			unknown,
			unknown,
			Scope.Scope
		>;
		const result = yield* Scope.provide(providedAcquire, entry.scope).pipe(
			Effect.matchEffect({
				onFailure: (cause) =>
					Effect.gen(function* () {
						yield* registry.markFailed(key, cause).pipe(Effect.catch(() => Effect.void));
						yield* publish(ref, hub, {
							tag: 'error.reported',
							error: prettyErrorStructured(Cause.fail(cause), {
								pluginKey: key,
								severity: 'error',
								at: Date.now(),
							}),
						});
						return { ok: false as const };
					}),
				onSuccess: (value: unknown) =>
					Effect.succeed({ ok: true as const, value: value as unknown }),
			}),
		);
		if (result.ok) {
			// Harvest contributions:
			//   1. The plugin's `capabilities` tuple (or post-acquire
			//      dynamic factory) — yields `CapabilityDecl`s.
			//   2. The plugin's `errorContributions` field — yields
			//      `PluginErrorContribution`s for the FormatterRegistry.
			// Registrations land on the plugin's scope so they reap on
			// plugin teardown (selective restart, shutdown). The
			// supervisor stays kind-blind: routing is the registry's job.
			const acquireContext: AcquireContext = {
				identity,
				chain: identity.chain,
				runtimeRoot,
			};
			const capsExit = yield* Effect.exit(
				resolveCapabilities(
					key,
					entry.node.member.capabilities as
						| ReadonlyArray<CapabilityDecl>
						| ((r: unknown, c: AcquireContext) => ReadonlyArray<CapabilityDecl>)
						| undefined,
					result.value,
					acquireContext,
				),
			);
			if (Exit.isFailure(capsExit)) {
				yield* registry.markFailed(key, capsExit.cause).pipe(Effect.catch(() => Effect.void));
				yield* publish(ref, hub, {
					tag: 'error.reported',
					error: prettyErrorStructured(capsExit.cause, {
						pluginKey: key,
						severity: 'error',
						at: Date.now(),
					}),
				});
				yield* logger.log(`supervisor/${key}`, key, {
					level: 'error',
					message: 'plugin capability factory failed',
				});
				return;
			}
			const caps = capsExit.value;
			const errorContributions = entry.node.member.errorContributions ?? [];
			if (caps.length > 0 || errorContributions.length > 0) {
				const dispatchExit = yield* Effect.exit(
					dispatchContributions(
						key,
						caps,
						errorContributions,
						entry.node.member.role,
						identity,
						pluginContext,
						entry.scope,
						sinks,
						ref,
						hub,
					),
				);
				if (Exit.isFailure(dispatchExit)) {
					yield* registry.markFailed(key, dispatchExit.cause).pipe(Effect.catch(() => Effect.void));
					yield* publish(ref, hub, {
						tag: 'error.reported',
						error: prettyErrorStructured(dispatchExit.cause, {
							pluginKey: key,
							severity: 'error',
							at: Date.now(),
						}),
					});
					yield* logger.log(`supervisor/${key}`, key, {
						level: 'error',
						message: 'plugin capability dispatch failed',
					});
					return;
				}
			}
			const routablesPresent = caps.some((capability) => capability.kind === 'routable');
			for (const event of operationalEndpointEventsFromResolvedValue(
				key,
				result.value,
				Date.now(),
				{
					routablesPresent,
				},
			)) {
				yield* publish(ref, hub, event);
			}
			yield* publish(ref, hub, {
				tag: 'lifecycle.phaseSet',
				pluginKey: key,
				phase: null,
				at: Date.now(),
			});
			// `markReady` populates the synchronous resolved-value map AND
			// resolves the deferred; downstream dependency resolution reads
			// from the former.
			yield* registry.markReady(key, result.value).pipe(Effect.catch(() => Effect.void));
			if (entry.node.member.role === 'task') {
				yield* registry.transition(key, 'done').pipe(Effect.catch(() => Effect.void));
			}
			yield* logger.log(`supervisor/${key}`, key, {
				level: 'debug',
				message: entry.node.member.role === 'task' ? 'plugin done' : 'plugin ready',
				fields: {
					capabilities: caps.length,
					errorContributions: errorContributions.length,
				},
			});
		} else {
			yield* logger.log(`supervisor/${key}`, key, {
				level: 'debug',
				message: 'plugin acquire failed',
			});
		}
	}).pipe(
		withPluginSpan('lifecycle.supervisor.acquireNode', {
			app: identity.app,
			stack: identity.stack,
			network: identity.chain,
			pluginKey: key,
			role: registry.entries.get(key)?.node.member.role ?? 'service',
		}),
	);

// -----------------------------------------------------------------------------
// Acquire a level batch in parallel
// -----------------------------------------------------------------------------

const acquireLevel = (
	registry: PluginRegistry,
	keys: ReadonlyArray<PluginKey>,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ 'devstack.level.size': keys.length });
		yield* Effect.all(
			keys.map((key) =>
				acquireNode(registry, key, ref, hub, pluginContext, sinks, logger, identity, runtimeRoot),
			),
			{ concurrency: 'unbounded', discard: true },
		);
	}).pipe(Effect.withSpan('lifecycle.supervisor.acquireLevel'));

const acquireFullGraph = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		yield* annotateOp('acquireFullGraph');
		for (const level of graph.levels) {
			yield* acquireLevel(
				registry,
				level,
				ref,
				hub,
				pluginContext,
				sinks,
				logger,
				identity,
				runtimeRoot,
			);
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.acquireFullGraph'));

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

/**
 * Tear down a slice in reverse-dep order, parallel within each level.
 * Each node's scope close runs its finalizers; status transitions
 * `ready → stopping → stopped` are emitted.
 *
 * Architecture § Stack lifecycle: "shutdown.requested → parallel
 * teardown (max grace, not sum grace)".
 */
const teardownKeys = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	keys: ReadonlyArray<PluginKey>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		// Bucket by level so the reverse-order array preserves the
		// "parallel within level" invariant.
		const byLevel: Array<Array<PluginKey>> = graph.levels.map(() => []);
		const keySet = new Set(keys);
		for (let i = 0; i < graph.levels.length; i++) {
			for (const key of graph.levels[i]!) {
				if (keySet.has(key)) byLevel[i]!.push(key);
			}
		}
		for (let i = byLevel.length - 1; i >= 0; i--) {
			const level = byLevel[i]!;
			if (level.length === 0) continue;
			yield* Effect.all(
				level.map((key) => teardownNode(registry, key)),
				{ concurrency: 'unbounded', discard: true },
			);
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.teardownKeys'));

const teardownNode = (
	registry: PluginRegistry,
	key: PluginKey,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const entry = registry.entries.get(key);
		if (entry === undefined) return;
		const status = yield* registry
			.getStatus(key)
			.pipe(Effect.catch(() => Effect.succeed<LifecycleStatus>('pending')));
		// Only `ready` plugins need stopping. `acquiring` plugins are
		// interrupted by the scope close. `failed` / `stopped` / `done`
		// are no-ops.
		if (status === 'ready') {
			yield* registry.transition(key, 'stopping').pipe(Effect.catch(() => Effect.void));
		}
		yield* Scope.close(entry.scope, Exit.void).pipe(Effect.catch(() => Effect.void));
		if (status === 'ready') {
			yield* registry.transition(key, 'stopped').pipe(Effect.catch(() => Effect.void));
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.teardownNode'));

// -----------------------------------------------------------------------------
// Selective restart
// -----------------------------------------------------------------------------

const doSelectiveRestart = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	roots: ReadonlySet<PluginKey>,
	pluginContext: Context.Context<never>,
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
	parentScope: Scope.Scope,
): Effect.Effect<void, RestartTargetMissing> =>
	Effect.gen(function* () {
		const plan = yield* planRestart(graph, roots);
		const at = Date.now();
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.requested',
				target: { pluginKey: root },
				at,
			});
		}
		yield* teardownKeys(graph, registry, plan.teardownOrder);
		// Re-acquire in forward level order. The dep-graph levels still
		// apply: a downstream node in the slice can't acquire until its
		// upstream (which may or may not be in the slice itself) is back
		// to `ready`. Nodes outside the slice are already `ready`.
		// We need to mark slice nodes back to `pending` so the state
		// machine accepts the `pending → acquiring` transition.
		for (const key of plan.acquireOrder) {
			yield* registry.resetForRestart(key, parentScope).pipe(Effect.catch(() => Effect.void));
			yield* registry.transition(key, 'pending').pipe(Effect.catch(() => Effect.void));
		}
		// Re-bucket by level for parallel acquire within each level.
		const sliceByLevel: Array<Array<PluginKey>> = graph.levels.map(() => []);
		const sliceSet = new Set(plan.slice);
		for (let i = 0; i < graph.levels.length; i++) {
			for (const key of graph.levels[i]!) {
				if (sliceSet.has(key)) sliceByLevel[i]!.push(key);
			}
		}
		for (const level of sliceByLevel) {
			if (level.length === 0) continue;
			yield* acquireLevel(
				registry,
				level,
				ref,
				hub,
				pluginContext,
				sinks,
				logger,
				identity,
				runtimeRoot,
			);
		}
		for (const root of roots) {
			yield* publish(ref, hub, {
				tag: 'restart.completed',
				target: { pluginKey: root },
				at: Date.now(),
			});
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.selectiveRestart'));

// -----------------------------------------------------------------------------
// Command loop
// -----------------------------------------------------------------------------

interface CommandLoopDeps {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly ref: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly hub: Queue.Enqueue<EngineEvent>;
	readonly commands: Queue.Dequeue<EngineCommand>;
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

type SnapshotCaptureTaskState =
	| { readonly tag: 'idle' }
	| { readonly tag: 'starting'; readonly token: number; readonly snapshotId: string | null }
	| {
			readonly tag: 'running';
			readonly token: number;
			readonly snapshotId: string | null;
			readonly fiber: Fiber.Fiber<void, never>;
	  };

const runInjectedCommandHandler = (
	deps: CommandLoopDeps,
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

const startBackgroundSnapshotCapture = (
	deps: CommandLoopDeps,
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

const requestBackgroundSnapshotInterrupt = (
	deps: Pick<CommandLoopDeps, 'snapshotCaptureTask'>,
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

const publishHookFailure = (
	deps: CommandLoopDeps,
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

const runPostAcquireHook = (
	deps: CommandLoopDeps,
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

const handleCommand = (
	deps: CommandLoopDeps,
	cmd: EngineCommand,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const {
			graph,
			registry,
			ref,
			hub,
			shutdownLatch,
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
				yield* requestBackgroundSnapshotInterrupt(deps);
				yield* setCyclePhase(ref, 'shutting-down');
				yield* Ref.set(shutdownLatch, true);
				yield* logger.log('supervisor', null, {
					level: 'info',
					message: 'shutdown requested',
				});
				const plan = planFullDrain(graph);
				yield* teardownKeys(graph, registry, plan.teardownOrder);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(deps.shutdownComplete, void 0).pipe(Effect.ignore);
				return;
			}
			case 'shutdown.hardKillRequested': {
				yield* requestBackgroundSnapshotInterrupt(deps);
				yield* publish(ref, hub, {
					tag: 'shutdown.escalated',
					signal: cmd.signal,
					exitCode: cmd.exitCode,
					at: cmd.at,
				});
				yield* setCyclePhase(ref, 'shutting-down');
				yield* Ref.set(shutdownLatch, true);
				yield* Deferred.succeed(deps.shutdownComplete, void 0).pipe(Effect.ignore);
				yield* logger.log('supervisor', null, {
					level: 'fatal',
					message: `shutdown escalated by ${cmd.signal}`,
					fields: { signal: cmd.signal, exitCode: cmd.exitCode },
				});
				return;
			}
			case 'stack.restart': {
				const plan = planFullDrain(graph);
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					ref,
					hub,
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
					yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
				}
				return;
			}
			case 'selective-restart.requested': {
				const restarted = yield* doSelectiveRestart(
					graph,
					registry,
					ref,
					hub,
					new Set<PluginKey>([cmd.pluginKey]),
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
					yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
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
						ref,
						hub,
						new Set<PluginKey>([cmd.pluginKey]),
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
						yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
					}
					return;
				}
				if (yield* allReadyOrTerminal(graph, registry)) {
					yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
				}
				return;
			}
			case 'codegen.requested': {
				if (yield* allReadyOrTerminal(graph, registry)) {
					yield* runPostAcquireHook(deps).pipe(Effect.catch(() => Effect.void));
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

const commandLoop = (deps: CommandLoopDeps): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		while (true) {
			const cmd = yield* Queue.take(deps.commands);
			yield* handleCommand(deps, cmd);
			const drained = yield* Ref.get(deps.shutdownLatch);
			if (drained) return;
		}
	}).pipe(Effect.withSpan('lifecycle.supervisor.commandLoop'));

// -----------------------------------------------------------------------------
// Top-level supervisor entry
// -----------------------------------------------------------------------------

export interface SupervisorHandle {
	readonly identity: Identity;
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly events: Queue.Dequeue<EngineEvent>;
	readonly commands: Queue.Enqueue<EngineCommand>;
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
 * the per-plugin Scope is provided). The orchestrator layer (L3)
 * builds this context once per stack from its layer stack and hands
 * it to the supervisor; substrate doesn't name the services itself
 * (the context is opaque `Context.Context<never>` at this boundary).
 *
 * `CapabilitySinksService` extension (ARCHITECTURE.md § Plugin-author
 * extension via Layer composition): if the caller layers a
 * `CapabilitySinksService` into `pluginContext`, the supervisor
 * harvests through THAT instance instead of building its own. This is
 * the seam plugin authors use to register custom-kind sinks: compose
 * `layerCapabilitySinksDefault(orchestratorSinks)` with one or more
 * `Layer.effectDiscard` overlays that yield `CapabilitySinksService`
 * and call `registerSink({ kind: 'my-custom', accept: ... })`. The
 * `sinks: OrchestratorSinks` parameter is ignored when context carries
 * a pre-built service (the caller's Layer already supplies whatever
 * sink registrations it wants).
 *
 * Architecture § Stack lifecycle:
 *   "defineStack(config) → Identity validated → NetworkResolver
 *    consulted → Plugin dep-graph computed → level-batched parallel
 *    acquire → manifest.flushed → ready event → cycle running."
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
		const baseLogger: LoggerShape = getOrDefault(pluginContext, Logger, noopLogger);

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
		// factories (`Plugin.capabilities` as a function). The
		// runtimeRoot is the on-disk base under which the stack's
		// state lives; identity carries app/stack/chain. Together
		// they let plugins stamp REAL paths and chain ids into their
		// snapshot subtrees, codegen bindings, routable URLs, etc.
		//
		// Fallback to '' if the caller didn't add `RuntimeRoot` to
		// the plugin context — keeps the bare `supervise()` smoke
		// tests working without a substrate Layer stack.
		const runtimeRoot = getOrDefault(pluginContext, RuntimeRoot, { root: '' }).root;

		// Resolve the CapabilitySinks registry for this stack. Two paths:
		//
		//   (a) Plugin-author / orchestrator pre-built path: the caller
		//       layered a `CapabilitySinksService` into `pluginContext`
		//       (typically by composing `layerCapabilitySinksDefault(...)`
		//       PLUS one or more custom-sink Layers). The supervisor
		//       harvests through THAT instance, so custom sinks
		//       registered by plugin authors actually fire. The
		//       `sinks: OrchestratorSinks` arg is ignored in this path
		//       (the caller already composed its own sink registrations
		//       into the Layer they handed in).
		//
		//   (b) Bare path: no service in context — the supervisor builds
		//       the substrate default with the orchestrator sinks passed
		//       in. `Layer.build` opens the layer's resources on the
		//       SURROUNDING scope (the supervisor's), so the sinks +
		//       formatter registry live for the supervisor's lifetime
		//       and reap on its scope close.
		//
		// Plugin-author symmetry (ARCHITECTURE.md § Plugin-author
		// surface = user-surface): a custom plugin registers its own
		// sinks via standard Layer composition, NOT by reaching into
		// the supervisor. Same surface a built-in (Logger, RuntimeRoot,
		// ContainerRuntime, etc.) uses.
		const sinksService = yield* getOrDefaultEffect(
			pluginRuntimeContext,
			CapabilitySinksService,
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
		}

		const commandLoopDeps: CommandLoopDeps = {
			graph,
			registry,
			ref: state,
			hub,
			commands,
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
			const alreadyStarted = yield* Ref.modify(initialAcquireStarted, (started) => [started, true]);
			if (alreadyStarted) return;
			if (yield* Ref.get(shutdownLatch)) return;
			// Fire the initial acquire — level-batched parallel. The plugin
			// context provides the substrate-context services the plugins'
			// acquire bodies yield (Identity, ContainerRuntime, etc.). The
			// substrate's `CapabilitySinksService` routes each harvested
			// contribution to the matching sink; production orchestrator
			// sinks are registered by the higher-level runtime composer.
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
				yield* runPostAcquireHook(commandLoopDeps);
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
				// If multiple keys matched, queue further selective-restarts
				// for each so the command loop processes them serially.
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
			yield* Effect.forkScoped(commandLoop(commandLoopDeps));
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

		const handle = {
			identity,
			graph,
			registry,
			events: hub,
			commands,
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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Run-to-completion helper (test + programmable API entry)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Public re-exports of the lifecycle subsystem types
// -----------------------------------------------------------------------------

export type { Fiber };
