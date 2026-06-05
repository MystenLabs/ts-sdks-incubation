// Per-plugin acquire pipeline.
//
// Three entrypoints:
//   - `buildRegistry(graph, parentScope, emit)` — boots the plugin
//     registry from a resolved graph; each plugin's scope is parented
//     to the supervisor's outer scope.
//   - `acquireNode(...)` — runs one plugin's `start` body inside its
//     entry scope; on success replays the ctx-buffered contributions
//     through the closed `ContributionDispatcher`.
//   - `acquireKeys` / `acquireFullGraph` — fan out per-node acquires
//     in parallel; each node waits on its own upstream ready gate.

import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Scope,
	SubscriptionRef,
} from 'effect';

import type { CodegenableDecl } from '../../../contracts/codegenable.ts';
import type { ProjectionDecl } from '../../../contracts/projection.ts';
import type { RoutableDecl } from '../../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { PluginCtx } from '../../plugin-ctx.ts';
import { PluginContext } from '../../plugin-ctx.ts';
import { resolvePluginDependencies } from '../../plugin.ts';
import type { SubscribableState } from '../../projection.ts';
import { StrategyRegistryService } from '../strategy-registry/service.ts';
import { CurrentPluginKey, CurrentPluginProgress } from '../current-plugin.ts';
import { prettyErrorStructured, type LoggerShape } from '../observability/index.ts';
import {
	awaitUpstreams,
	buildDependencyReaderFor,
	makeEntry,
	makeRegistry,
	type PluginEntry,
	type PluginRegistry,
	type ResolvedGraph,
} from '../lifecycle/index.ts';
import { operationalEndpointEventsFromResolvedValue } from '../projection/operational-endpoints.ts';
import type {
	ContributionDispatcher,
	ContributionDispatchContext,
} from './contribution-dispatcher.ts';
import { bestEffort, noopStrategyRegistry, OptionalService, publish } from './wiring.ts';

// A single buffered contribution — a discriminated union over the five
// closed decl kinds, in the order the plugin's `start` emitted them.
type BufferedContribution =
	| SnapshotableDecl
	| CodegenableDecl<string>
	| RoutableDecl
	| ProjectionDecl
	| StrategyContributorDecl<string, unknown>;

/**
 * Thrown (as a DEFECT, not a typed failure) when a plugin emits a ctx
 * contribution AFTER its `start` returned and the buffer was sealed
 * (PR#3). The buffer is the SOLE source of post-start contributions and
 * is read exactly once after `start`; a late async emission — e.g. a verb
 * called from a fiber the plugin forked but did not await — would
 * otherwise be silently dropped (a route that never registers, a codegen
 * file that never emits, with the plugin still `ready`). Sealing turns
 * that silent loss into a loud, attributable crash on the OFFENDING
 * fiber. The verb signatures return `void`, so this surfaces as a thrown
 * defect rather than an Effect failure. */
export class ContributionBufferSealedError extends Error {
	readonly _tag = 'ContributionBufferSealedError' as const;
	constructor(pluginKey: PluginKey | null, kind: string) {
		super(
			`plugin${pluginKey === null ? '' : ` '${pluginKey}'`} emitted a '${kind}' contribution ` +
				`after start() returned (the contribution buffer is sealed). Emit all ctx.* ` +
				`contributions synchronously within start(); a late async emission would be ` +
				`silently dropped.`,
		);
		this.name = 'ContributionBufferSealedError';
	}
}

// -----------------------------------------------------------------------------
// Per-plugin PluginCtx
// -----------------------------------------------------------------------------

const strategyRegistryAccess = OptionalService(StrategyRegistryService);

/**
 * Build the per-plugin `PluginCtx` + its replay buffer. The four
 * declarative verbs (`codegen`/`endpoint`/`snapshotExtra`/`publish`) and
 * the strategy-bus writer (`provides`) PUSH a typed `BufferedContribution`
 * into `buffer` IN EMIT ORDER; the supervisor replays that buffer through
 * the closed `ContributionDispatcher` after a successful `start`. The
 * buffer is the SOLE source of post-start contributions.
 */
const makePluginCtx = (
	pluginKey: PluginKey,
): {
	readonly ctx: PluginCtx;
	readonly buffer: BufferedContribution[];
	readonly sealBuffer: () => void;
} => {
	const buffer: BufferedContribution[] = [];
	// PR#3: the buffer is read exactly once after `start` returns, then
	// frozen. A push afterwards is a late async emission that would be
	// silently dropped — throw a loud, attributable defect instead.
	let frozen = false;
	const pushOrThrow = (kind: string, decl: BufferedContribution): void => {
		if (frozen) throw new ContributionBufferSealedError(pluginKey, kind);
		buffer.push(decl);
	};
	const ctx: PluginCtx = {
		codegen: <E extends string>(decl: CodegenableDecl<E>): void => {
			pushOrThrow('codegenable', decl);
		},
		endpoint: (decl: RoutableDecl): void => {
			pushOrThrow('routable', decl);
		},
		snapshotExtra: (decl: SnapshotableDecl): void => {
			pushOrThrow('snapshotable', decl);
		},
		publish: (decl: ProjectionDecl): void => {
			pushOrThrow('projection', decl);
		},
		provides: <K extends string, S>(decl: StrategyContributorDecl<K, S>): void => {
			pushOrThrow('strategy-contributor', decl);
		},
	};
	return {
		ctx,
		buffer,
		sealBuffer: () => {
			frozen = true;
		},
	};
};

// -----------------------------------------------------------------------------
// Static post-start dispatch
// -----------------------------------------------------------------------------

/**
 * Render the underlying cause of a contribution-dispatch failure to a
 * single operator-facing string. A failing dispatch body (e.g. a router
 * route collision) may reject with an Effect `Cause`, a tagged domain
 * error (carrying a spec-mismatch `detail`), a plain `Error`, or an
 * arbitrary value. The plugin stays `ready`, so without this the
 * operator would see a healthy-looking stack with dead routing.
 */
const formatCause = (cause: unknown): string => {
	if (Cause.isCause(cause)) return Cause.pretty(cause);
	if (cause instanceof Error) return cause.stack ?? cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause) ?? String(cause);
	} catch {
		return String(cause);
	}
};

/** Best-effort `_tag` of the failing cause for the additive `causeType`
 *  on the `dispatchFailed` event. */
const causeTagOf = (cause: unknown): string | undefined => {
	if (
		typeof cause === 'object' &&
		cause !== null &&
		'_tag' in cause &&
		typeof (cause as { _tag: unknown })._tag === 'string'
	) {
		return (cause as { _tag: string })._tag;
	}
	return undefined;
};

/**
 * Replay one plugin's buffered contributions through the closed
 * `ContributionDispatcher` after a successful `start`.
 *
 * Failure semantics: a dispatch BODY failure is an orchestrator-fault —
 * the supervisor publishes
 * `engine.orchestrator.dispatchFailed` + logs a warning, and the plugin
 * stays `ready` (NOT `markFailed`). The contribution kinds are a CLOSED
 * union, so the dispatch is an exhaustive switch on the decl
 * discriminant (no UnknownContributionKind arm).
 *
 * Runs on the plugin's scope (`pluginScope`) so any finalizer a dispatch
 * body arms (e.g. `strategy.unregistered`) reaps on plugin teardown.
 */
const dispatchBufferedContributions = (
	pluginKey: PluginKey,
	buffer: ReadonlyArray<BufferedContribution>,
	pluginContext: Context.Context<never>,
	pluginScope: Scope.Scope,
	dispatcher: ContributionDispatcher,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const strategyRegistry = strategyRegistryAccess.read(pluginContext, noopStrategyRegistry);
		const dispatchCtx: ContributionDispatchContext = {
			pluginKey,
			publish: (event) => publish(ref, hub, event),
			strategyRegistry,
		};

		for (const decl of buffer) {
			const body = ((): Effect.Effect<void, unknown, Scope.Scope> => {
				switch (decl.kind) {
					case 'snapshotable':
						return dispatcher.snapshotable(decl, dispatchCtx);
					case 'codegenable':
						return dispatcher.codegenable(decl, dispatchCtx);
					case 'routable':
						return dispatcher.routable(decl, dispatchCtx);
					case 'projection':
						return dispatcher.projection(decl, dispatchCtx);
					case 'strategy-contributor':
						return dispatcher.strategyContributor(decl, dispatchCtx);
					default: {
						const _exhaustive: never = decl;
						void _exhaustive;
						return Effect.void;
					}
				}
			})();
			// Orchestrator-fault path: a dispatch body failure surfaces the
			// typed `dispatchFailed` event + warning WITHOUT marking the
			// plugin failed (the plugin already reached a good `start`).
			const guarded = body.pipe(
				Effect.catch((cause) =>
					Effect.gen(function* () {
						const causeType = causeTagOf(cause);
						yield* publish(ref, hub, {
							tag: 'engine.orchestrator.dispatchFailed',
							pluginKey,
							kind: decl.kind,
							message: `routing/contribution sink '${decl.kind}' failed`,
							...(causeType === undefined ? {} : { causeType }),
							at: Date.now(),
						});
						yield* Effect.logWarning(
							`routing/contribution sink '${decl.kind}' failed for plugin '${pluginKey}': ${formatCause(cause)}`,
						);
					}),
				),
			);
			yield* Scope.provide(guarded, pluginScope);
		}
	});

// -----------------------------------------------------------------------------
// Boot the registry from a graph
// -----------------------------------------------------------------------------

export const buildRegistry = (
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
// Acquire one node
// -----------------------------------------------------------------------------

/**
 * Run one node's `start` under its own scope. Steps:
 *  1. Await upstreams (their ready-gates).
 *  2. Transition `pending → acquiring` (publishes the event).
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
export const acquireNode = (
	registry: PluginRegistry,
	key: PluginKey,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	dispatcher: ContributionDispatcher,
	logger: LoggerShape,
	// Threaded through the acquire path for parity with acquireKeys/
	// acquireFullGraph; no longer read here (only the removed span used it).
	_identity: Identity,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const entry = registry.entries.get(key);
		if (entry === undefined) return;
		const upstreamWait = awaitUpstreams(registry, entry.node).pipe(
			Effect.matchEffect({
				onFailure: (cause) =>
					Effect.gen(function* () {
						yield* bestEffort(registry.markFailed(key, cause));
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
		yield* logger.log(`supervisor/${key}`, key, {
			level: 'debug',
			message: 'plugin acquire start',
			fields: { role: entry.node.member.role },
		});
		// Best-effort claim. `transition` `Effect.die`s on an off-table move,
		// which a concurrent acquire can trigger: an in-flight initial
		// `acquireNode` racing a selective-restart re-acquire of the same key
		// hits `acquiring → acquiring`. `Effect.catch` (used originally here)
		// cannot catch that DEFECT, so it would escape and kill the
		// command-loop fiber (supervisor wedge — same class as the lifecycle
		// reset fix). `Effect.exit` swallows BOTH failure and defect, keeping
		// this the best-effort transition it was always meant to be.
		// NOTE: this prevents the wedge but not the underlying double-acquire
		// (two fibers running one node's `start`). A complete fix must
		// interrupt a node's in-flight acquire fiber before a restart
		// re-acquires it — tracked as a follow-up (needs per-node acquire-fiber
		// handles, which `acquireKeys`' `Effect.all` does not retain today).
		yield* Effect.exit(registry.transition(key, 'acquiring'));
		const readDependency = buildDependencyReaderFor(registry, entry.node);
		const deps = resolvePluginDependencies(entry.node.member, readDependency);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const start = entry.node.member.start as (
			deps: unknown,
		) => Effect.Effect<unknown, unknown, any>;
		// Build the per-plugin ctx + replay buffer. Every plugin emits its
		// contributions inline via the typed `ctx` verbs during `start`; the
		// buffer is the SOLE source of the post-start dispatch.
		// The ctx is delivered through the `PluginContext` service tag (a
		// plugin reaches it with `yield* PluginContext`), provided into the
		// start Effect's requirement channel below — NOT as a 2nd positional
		// argument — which keeps `start` single-arg and `deps` auto-inferred.
		const { ctx: pluginCtx, buffer, sealBuffer } = makePluginCtx(key);
		const currentPluginContext = pluginContext.pipe(
			Context.add(CurrentPluginKey, { key }),
			Context.add(PluginContext, pluginCtx),
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
						yield* bestEffort(registry.markFailed(key, cause));
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
		// PR#3: `start` has resolved — the contribution buffer is now FINAL and
		// is read exactly once below. Freeze it so any late async `ctx.*`
		// emission (a verb called from a fiber the plugin forked but did not
		// await) crashes the OFFENDING fiber with a typed defect instead of
		// being silently dropped.
		sealBuffer();
		if (result.ok) {
			// The ctx buffer (decls the 5 verbs pushed during `start`, in
			// emit order) is the SOLE source of post-start contributions.
			// The dispatch is a closed exhaustive switch on the decl
			// discriminant — its internal dual-catch keeps an
			// orchestrator-fault (a failing dispatch body) off the plugin's
			// `markFailed` path, so a surfaced failure here would be an
			// unexpected defect only.
			if (buffer.length > 0) {
				const dispatchExit = yield* Effect.exit(
					dispatchBufferedContributions(
						key,
						buffer,
						pluginContext,
						entry.scope,
						dispatcher,
						ref,
						hub,
					),
				);
				if (Exit.isFailure(dispatchExit)) {
					yield* bestEffort(registry.markFailed(key, dispatchExit.cause));
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
			const routablesPresent = buffer.some((decl) => decl.kind === 'routable');
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
			yield* bestEffort(registry.markReady(key, result.value));
			if (entry.node.member.role === 'task') {
				yield* bestEffort(registry.transition(key, 'done'));
			}
			yield* logger.log(`supervisor/${key}`, key, {
				level: 'debug',
				message: entry.node.member.role === 'task' ? 'plugin done' : 'plugin ready',
				fields: {
					contributions: buffer.length,
				},
			});
		} else {
			yield* logger.log(`supervisor/${key}`, key, {
				level: 'debug',
				message: 'plugin acquire failed',
			});
		}
	});

class PluginAcquireInterruptedBeforeReady extends Error {
	readonly _tag = 'PluginAcquireInterruptedBeforeReady' as const;
	constructor(readonly pluginKey: PluginKey) {
		super(`plugin '${pluginKey}' acquire was interrupted before readiness`);
		this.name = 'PluginAcquireInterruptedBeforeReady';
	}
}

const failIfAcquireInterruptedBeforeReady = (
	registry: PluginRegistry,
	key: PluginKey,
	entry: PluginEntry,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		if (registry.entries.get(key) !== entry) return;
		const status = yield* registry
			.getStatus(key)
			.pipe(Effect.catch(() => Effect.succeed<LifecycleStatus | null>(null)));
		if (registry.entries.get(key) !== entry) return;
		if (status !== 'pending' && status !== 'acquiring') return;
		yield* bestEffort(registry.markFailed(key, new PluginAcquireInterruptedBeforeReady(key)));
	});

// -----------------------------------------------------------------------------
// Acquire a key set in parallel. Each node waits on its own upstreams,
// so downstream nodes begin as soon as their dependencies are ready
// instead of waiting for unrelated nodes in the same topological level.
// -----------------------------------------------------------------------------

export const acquireKeys = (
	registry: PluginRegistry,
	keys: ReadonlyArray<PluginKey>,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	dispatcher: ContributionDispatcher,
	logger: LoggerShape,
	identity: Identity,
	parentScope: Scope.Scope,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const fibers = yield* Effect.all(
			keys.map((key) =>
				Effect.gen(function* () {
					const entry = registry.entries.get(key);
					if (entry === undefined) return yield* Effect.forkIn(Effect.void, parentScope);
					const registeredGate = yield* Deferred.make<void, never>();
					const guarded = Effect.gen(function* () {
						const selfId = yield* Effect.fiberId;
						yield* Deferred.await(registeredGate);
						yield* acquireNode(
							registry,
							key,
							ref,
							hub,
							pluginContext,
							dispatcher,
							logger,
							identity,
						).pipe(
							Effect.onInterrupt(() => failIfAcquireInterruptedBeforeReady(registry, key, entry)),
							Effect.ensuring(
								registry
									.clearAcquireFiberIfEntry(key, entry, selfId)
									.pipe(Effect.catch(() => Effect.void)),
							),
						);
					});
					const fiber = yield* Effect.forkIn(Scope.provide(guarded, parentScope), parentScope);
					const registered = yield* registry
						.setAcquireFiberIfEntry(key, entry, fiber)
						.pipe(Effect.catch(() => Effect.succeed(false)));
					if (!registered) {
						yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
						return fiber;
					}
					yield* Deferred.succeed(registeredGate, void 0);
					return fiber;
				}),
			),
			{ concurrency: 'unbounded' },
		);
		yield* Effect.all(
			fibers.map((fiber) =>
				Fiber.await(fiber).pipe(
					Effect.flatMap((exit) => {
						if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
							return Effect.void;
						}
						return Effect.failCause(exit.cause);
					}),
				),
			),
			{ concurrency: 'unbounded', discard: true },
		);
	});

export const acquireFullGraph = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	pluginContext: Context.Context<never>,
	dispatcher: ContributionDispatcher,
	logger: LoggerShape,
	identity: Identity,
	parentScope: Scope.Scope,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		yield* acquireKeys(
			registry,
			[...graph.nodes.keys()],
			ref,
			hub,
			pluginContext,
			dispatcher,
			logger,
			identity,
			parentScope,
		);
	});
