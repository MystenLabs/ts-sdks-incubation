// Control-plane domain builder.
//
// Assembles the generic, name-blind `ControlPlaneDomain` accessor surface
// from the data the supervisor holds at wiring time: the resolved plugin
// registry + graph, the (optional) snapshot orchestrator + filesystem (for
// snapshot catalog reads), and the cross-service observability stores.
//
// Design discipline:
//   - The projection (`SubscribableState`) is CLOSED — none of this data
//     touches it. We read resolved plugin VALUES via `readResolvedSync`,
//     the same name-blind seam `orchestrators/boot.ts` uses for the
//     manifest-extras lookup, and hand them out UNINTERPRETED via
//     `resolvedValues`. The substrate never pattern-matches plugin
//     names — plugin-name-aware shaping lives in the dashboard plugin
//     (allowed to name plugins), one layer up.
//   - Every accessor degrades to empty/`null` rather than failing, so a
//     single missing/uninitialised plugin can't take down a dashboard
//     query (`E = never` on the public surface).

import { Context, Effect, FileSystem } from 'effect';

import type { ResolvedGraph } from '../lifecycle/index.ts';
import { readResolvedSync, type PluginRegistry } from '../lifecycle/plugin-registry.ts';
import type { DevstackOptions } from '../../options.ts';
// Cross-layer seam (intentional): the control-plane domain is the single
// place the substrate reads the L3 snapshot orchestrator, so the
// supervisor core stays free of that import. This is a runtime VALUE import
// (the `Context.Key` tag) — confined here.
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
} from '../../../orchestrators/snapshot/service.ts';
import {
	computeSnapshotGraphInputFromGraph,
	graphInputMismatchDetail,
	type SnapshotGraphInputIdentity,
} from '../../../orchestrators/snapshot/index.ts';
import type {
	ControlPlaneDomain,
	ControlPlaneResolvedValue,
	ControlPlaneSnapshotEntry,
} from './service.ts';
import type { LogStoreShape } from '../observability/index.ts';

// -----------------------------------------------------------------------------
// Generic resolved-value enumeration
//
// We import NO plugin types — the plugins live above the substrate in the
// layering. We hand out the opaque `unknown` resolved value alongside its
// registry key + resource id; the consumer (the dashboard plugin) does any
// narrowing/shaping by resource-id prefix itself.
// -----------------------------------------------------------------------------

/** Enumerate every resolved plugin value, in graph order, as
 *  `{ pluginKey, id, value }` triples. Skips nodes with no resolved value.
 *  The substrate never inspects `id` or `value` — they pass through
 *  uninterpreted. */
const enumerateResolvedValues = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
): ReadonlyArray<ControlPlaneResolvedValue> => {
	const out: Array<ControlPlaneResolvedValue> = [];
	for (const [key, node] of graph.nodes) {
		const value = readResolvedSync(registry, key);
		if (value === undefined || value === null) continue;
		out.push({ pluginKey: String(key), id: node.member.id, value });
	}
	return out;
};

// -----------------------------------------------------------------------------
// Snapshot catalog projection
// -----------------------------------------------------------------------------

const snapshotEntryFrom = (
	entry: {
		readonly id: string;
		readonly metadata: {
			readonly label?: string | null;
			readonly createdAt?: number;
			readonly app?: string;
			readonly stack?: string;
			readonly network?: string;
			readonly graphInput?: {
				readonly graphInputId?: string;
			};
			readonly participants?: ReadonlyArray<string>;
			readonly containers?: ReadonlyArray<unknown>;
			readonly subtrees?: ReadonlyArray<unknown>;
		} | null;
	},
	currentGraphInput: SnapshotGraphInputIdentity | null,
): ControlPlaneSnapshotEntry => {
	const m = entry.metadata;
	const snapshotGraphInputId = m?.graphInput?.graphInputId ?? null;
	const currentGraphInputId = currentGraphInput?.graphInputId ?? null;
	const graphInputStatus =
		snapshotGraphInputId === null || currentGraphInputId === null
			? 'unknown'
			: snapshotGraphInputId === currentGraphInputId
				? 'matching'
				: 'stale';
	const graphInputWarning =
		snapshotGraphInputId === null || currentGraphInputId === null || graphInputStatus !== 'stale'
			? null
			: graphInputMismatchDetail(snapshotGraphInputId, currentGraphInputId);
	return {
		id: entry.id,
		label: m?.label ?? null,
		createdAt: m?.createdAt ?? null,
		app: m?.app ?? null,
		stack: m?.stack ?? null,
		network: m?.network ?? null,
		snapshotGraphInputId,
		currentGraphInputId,
		graphInputStatus,
		graphInputWarning,
		participants: m?.participants ?? [],
		containerCount: m?.containers?.length ?? 0,
		subtreeCount: m?.subtrees?.length ?? 0,
		corrupt: m === null,
	};
};

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export interface ControlPlaneDomainDeps {
	readonly graph: ResolvedGraph;
	readonly stackOptions: DevstackOptions;
	readonly devstackVersion: string | null;
	readonly registry: PluginRegistry;
	/** Optional — present in production wiring (CLI / runStack), absent in
	 *  bare smoke tests. Snapshot accessors degrade to empty when missing. */
	readonly snapshotOrchestrator: SnapshotOrchestrator | null;
	/** Optional filesystem (snapshot orchestrator effects require it). */
	readonly fileSystem: FileSystem.FileSystem | null;
	/** Optional cross-service log store. Absent in bare smoke-test paths;
	 *  the `logs`/`logServices` accessors degrade to empty when null. */
	readonly logStore: LogStoreShape | null;
}

export const buildControlPlaneDomain = (deps: ControlPlaneDomainDeps): ControlPlaneDomain => {
	const {
		graph,
		stackOptions,
		devstackVersion,
		registry,
		snapshotOrchestrator,
		fileSystem,
		logStore,
	} = deps;

	const provideFs = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem>): Effect.Effect<A, E> =>
		fileSystem === null
			? (Effect.die('control-plane: FileSystem unavailable') as Effect.Effect<A, E>)
			: Effect.provideService(eff, FileSystem.FileSystem, fileSystem);

	const currentGraphInput =
		devstackVersion === null
			? Effect.succeed(null)
			: computeSnapshotGraphInputFromGraph({
					graph,
					options: stackOptions,
					devstackVersion,
				}).pipe(Effect.catchCause(() => Effect.succeed(null)));

	const snapshots: ControlPlaneDomain['snapshots'] =
		snapshotOrchestrator === null
			? Effect.succeed([])
			: provideFs(
					Effect.all({
						entries: snapshotOrchestrator.list,
						currentGraphInput,
					}),
				).pipe(
					Effect.map(({ entries, currentGraphInput }) =>
						entries.map((entry) => snapshotEntryFrom(entry, currentGraphInput)),
					),
					Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ControlPlaneSnapshotEntry>)),
				);

	const restoreSnapshot: ControlPlaneDomain['restoreSnapshot'] = (id) =>
		snapshotOrchestrator === null
			? Effect.succeed({ ok: false, detail: 'snapshot orchestrator unavailable' as string | null })
			: provideFs(
					currentGraphInput.pipe(
						Effect.flatMap((current) =>
							snapshotOrchestrator.restore({
								id,
								...(current === null
									? {}
									: {
											currentGraphInput: current,
											graphInputMismatchPolicy: 'warn' as const,
										}),
							}),
						),
					),
				).pipe(
					Effect.map(() => ({ ok: true, detail: null as string | null })),
					Effect.catchCause((cause) =>
						Effect.succeed({ ok: false, detail: String(cause) as string | null }),
					),
				);

	const deleteSnapshot: ControlPlaneDomain['deleteSnapshot'] = (id) =>
		snapshotOrchestrator === null
			? Effect.succeed({ ok: false, detail: 'snapshot orchestrator unavailable' as string | null })
			: provideFs(snapshotOrchestrator.delete(id)).pipe(
					Effect.map(() => ({ ok: true, detail: null as string | null })),
					Effect.catchCause((cause) =>
						Effect.succeed({ ok: false, detail: String(cause) as string | null }),
					),
				);

	// Generic, name-blind resolved-value enumeration. The seam the
	// dashboard plugin uses to find + shape plugin-domain values itself.
	const resolvedValues: ControlPlaneDomain['resolvedValues'] = Effect.sync(() =>
		enumerateResolvedValues(graph, registry),
	);

	// Observability accessors. These read the process-scoped log store the
	// supervisor created (fed off the same Logger path as the projection
	// tail). Filtering happens server-side in the store; the dashboard never
	// pulls the whole ring across the wire. Degrades to empty when the store
	// is absent.
	const logs: ControlPlaneDomain['logs'] = (filter) =>
		logStore === null ? Effect.succeed([]) : logStore.query(filter);

	const logServices: ControlPlaneDomain['logServices'] =
		logStore === null ? Effect.succeed([]) : logStore.services;

	return {
		snapshots,
		restoreSnapshot,
		deleteSnapshot,
		resolvedValues,
		logs,
		logServices,
	};
};

/** An all-empty domain surface. Used by bare smoke-test paths and the
 *  dashboard server tests that exercise the projection/command plane
 *  without a live registry. Every accessor resolves to empty/`null`. */
export const emptyControlPlaneDomain: ControlPlaneDomain = {
	snapshots: Effect.succeed([]),
	restoreSnapshot: () => Effect.succeed({ ok: false, detail: 'unavailable' }),
	deleteSnapshot: () => Effect.succeed({ ok: false, detail: 'unavailable' }),
	resolvedValues: Effect.succeed([]),
	logs: () => Effect.succeed([]),
	logServices: Effect.succeed([]),
};

/** Read an optional service value out of a `Context.Context<never>`,
 *  returning `null` when absent. */
const readOptional = <S, I>(ctx: Context.Context<never>, tag: Context.Key<I, S>): S | null => {
	const opt = Context.getOption(ctx as Context.Context<I>, tag);
	return opt._tag === 'Some' ? opt.value : null;
};

/** Build the control-plane domain by reading the optional snapshot
 *  orchestrator / filesystem services out of the supervisor's
 *  `pluginContext`. The supervisor calls THIS (not `buildControlPlaneDomain`
 *  directly) so the L3 service tag stays imported only inside the
 *  control-plane seam, never in the supervisor core. Each is optional: bare
 *  smoke-test `supervise()` paths don't layer them, so the corresponding
 *  accessors degrade to empty. */
export const controlPlaneDomainFromContext = (args: {
	readonly pluginContext: Context.Context<never>;
	readonly graph: ResolvedGraph;
	readonly stackOptions: DevstackOptions;
	readonly devstackVersion?: string | null;
	readonly registry: PluginRegistry;
	/** The supervisor's process-scoped log store, passed directly (it is
	 *  created in the supervisor closure, not layered into `pluginContext`).
	 *  `null` in bare smoke-test paths that don't build one. */
	readonly logStore?: LogStoreShape | null;
}): ControlPlaneDomain =>
	buildControlPlaneDomain({
		graph: args.graph,
		stackOptions: args.stackOptions,
		devstackVersion: args.devstackVersion ?? null,
		registry: args.registry,
		snapshotOrchestrator: readOptional(args.pluginContext, SnapshotOrchestratorService),
		fileSystem: readOptional(args.pluginContext, FileSystem.FileSystem),
		logStore: args.logStore ?? null,
	});
