// Per-plugin acquire pipeline.
//
// Three entrypoints:
//   - `buildRegistry(graph, parentScope, emit)` — boots the plugin
//     registry from a resolved graph; each plugin's scope is parented
//     to the supervisor's outer scope.
//   - `acquireNode(...)` — runs one plugin's `start` body inside its
//     entry scope; on success harvests `capabilities` +
//     `errorContributions` and registers them through `CapabilitySinks`.
//   - `acquireKeys` / `acquireFullGraph` — fan out per-node acquires
//     in parallel; each node waits on its own upstream ready gate.

import { Cause, Context, Effect, Exit, Queue, Scope, SubscriptionRef } from 'effect';

import type { ArtifactPublisher, ArtifactSpec } from '../../../primitives/artifact-publisher.ts';
import type { CapabilityDecl } from '../../../contracts/capability-decl.ts';
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
import { resolvePluginDependencies, type AcquireContext } from '../../plugin.ts';
import type { SubscribableState } from '../../projection.ts';
import { ArtifactPublisherService } from '../artifact-publisher/index.ts';
import { type CapabilitySinksShape } from '../capability-sinks/index.ts';
import { StrategyRegistryService } from '../strategy-registry/service.ts';
import { CurrentPluginKey, CurrentPluginProgress } from '../current-plugin.ts';
import {
	annotateOp,
	annotatePhase,
	prettyErrorStructured,
	withPluginSpan,
	type LoggerShape,
} from '../observability/index.ts';
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
import { dispatchContributions, resolveCapabilities } from './dispatch-contributions.ts';
import { bestEffort, noopStrategyRegistry, OptionalService, publish } from './wiring.ts';

// -----------------------------------------------------------------------------
// Per-plugin PluginCtx (Stage B foundation — P0/P0.5/P1)
// -----------------------------------------------------------------------------

const artifactPublisherAccess = OptionalService(ArtifactPublisherService);
const strategyRegistryAccess = OptionalService(StrategyRegistryService);

/** Fallback publisher for bare supervisor paths that don't layer an
 *  ArtifactPublisherService into `pluginContext` (smoke tests). A real
 *  stack always carries it (see `orchestrators/run.ts`
 *  `buildPluginContext`); persisting plugins only run there. */
const noopPublisher: ArtifactPublisher = {
	publish: <Produced, Verified>(_spec: ArtifactSpec<Produced, Verified>) =>
		Effect.fail({
			_tag: 'ArtifactPublishError' as const,
			reason: 'produce-failed' as const,
			detail: 'no ArtifactPublisherService in plugin context',
		}),
};

/**
 * Build the per-plugin `PluginCtx` + its replay buffer. The four
 * declarative verbs (`codegen`/`endpoint`/`snapshotExtra`/`publish`) and
 * the strategy-bus writer (`provides`) PUSH a typed `CapabilityDecl`
 * into `buffer`; the supervisor replays that buffer (concatenated with
 * the legacy `resolveCapabilities` output) through the SAME
 * `dispatchContributions` path after a successful `start`. Because no
 * plugin emits ctx verbs yet, `buffer` is empty in production →
 * combined == legacy → dispatch is byte-identical.
 *
 * `persist` is a thin pass-through to the ArtifactPublisher primitive
 * read from `pluginContext` (forwards the plugin-supplied hex
 * `spec.chain` verbatim). `requires` reads the scope-local
 * StrategyRegistry → `StrategyNotFoundError`. `fail` is `Effect.fail`.
 */
const makePluginCtx = (
	pluginContext: Context.Context<never>,
): { readonly ctx: PluginCtx; readonly buffer: CapabilityDecl[] } => {
	const buffer: CapabilityDecl[] = [];
	const publisher = artifactPublisherAccess.read(pluginContext, noopPublisher);
	const strategyRegistry = strategyRegistryAccess.read(pluginContext, noopStrategyRegistry);
	const ctx: PluginCtx = {
		persist: (spec) => publisher.publish(spec),
		codegen: <E extends string>(decl: CodegenableDecl<E>): void => {
			buffer.push(decl);
		},
		endpoint: (decl: RoutableDecl): void => {
			buffer.push(decl);
		},
		snapshotExtra: (decl: SnapshotableDecl): void => {
			buffer.push(decl);
		},
		publish: (decl: ProjectionDecl): void => {
			buffer.push(decl);
		},
		provides: <K extends string, S>(decl: StrategyContributorDecl<K, S>): void => {
			buffer.push(decl as CapabilityDecl);
		},
		requires: <K extends string>(capabilityKey: K) =>
			strategyRegistry.get<K, unknown>(capabilityKey),
		fail: (error) => Effect.fail(error) as Effect.Effect<never>,
	};
	return { ctx, buffer };
};

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
	sinks: CapabilitySinksShape,
	logger: LoggerShape,
	identity: Identity,
	runtimeRoot: string,
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
		yield* annotatePhase('acquire');
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
			ctx?: PluginCtx,
		) => Effect.Effect<unknown, unknown, any>;
		// Stage B foundation: build the per-plugin ctx + replay buffer. The
		// buffer stays EMPTY for every unconverted plugin (their `start`
		// ignores the 2nd arg), so the combined contribution list below is
		// byte-identical to the legacy `resolveCapabilities` output.
		const { ctx: pluginCtx, buffer } = makePluginCtx(pluginContext);
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
		const providedAcquire = Effect.provide(
			start(deps, pluginCtx),
			currentPluginContext,
		) as Effect.Effect<unknown, unknown, Scope.Scope>;
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
		if (result.ok) {
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
				yield* bestEffort(registry.markFailed(key, capsExit.cause));
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
			// P0.5: combined contribution list = REPLAYED ctx buffer (decls
			// pushed by the 5 buffered verbs during `start`, in emit order)
			// CONCATENATED with the legacy `resolveCapabilities` output. The
			// combined list feeds the SAME `dispatchContributions` path, so
			// sinks/dispatch are untouched — only the SOURCE changes. The
			// buffer is empty for every unconverted plugin → combined ==
			// legacy → byte-identical to today's harvest.
			const caps: ReadonlyArray<CapabilityDecl> = [...buffer, ...capsExit.value];
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
					// dispatchContributions catches both UnknownContributionKind
					// (no-op) and ContributionSinkFailed (orchestrator event +
					// warning) internally. A surfaced failure here therefore
					// reflects an unexpected defect — keep the legacy
					// markFailed projection so the unknown shape doesn't
					// silently degrade the plugin.
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
			yield* bestEffort(registry.markReady(key, result.value));
			if (entry.node.member.role === 'task') {
				yield* bestEffort(registry.transition(key, 'done'));
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
	}).pipe(Effect.withSpan('lifecycle.supervisor.acquireKeys'));

export const acquireFullGraph = (
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
		yield* acquireKeys(
			registry,
			[...graph.nodes.keys()],
			ref,
			hub,
			pluginContext,
			sinks,
			logger,
			identity,
			runtimeRoot,
		);
	}).pipe(Effect.withSpan('lifecycle.supervisor.acquireFullGraph'));
