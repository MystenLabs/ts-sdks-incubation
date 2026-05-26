// Projection updater.
//
// Architecture § Renderer § "Subscribable projection — exact field
// enumeration" (G2). The updater is a typed event-handler: each
// `EngineEvent` produces a structurally-typed projection mutation.
// Renderers never see the event taxonomy here; they only see the
// resulting state.
//
// The updater is *pure data*: it takes the old state + an event,
// returns the new state. Atomicity comes from
// `SubscriptionRef.update` at the call site.
//
// Discipline:
//   - No display vocabulary (`title`, `primary`, `extras`) anywhere
//     in the produced state.
//   - All fields the architecture enumerates are reachable; new
//     event tags are picked up via exhaustive `tag` match (the
//     `_exhaustive: never` line will fail to type-check if a new
//     tag is added without a handler here).

import { Effect, SubscriptionRef } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type {
	AccountProjection,
	BuildEntry,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
} from '../../projection.ts';
import { applyLifecycleFact, factFromEvent } from '../lifecycle/lifecycle-fact.ts';

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Bounded buffer for the top-level errors list. */
const MAX_ERRORS_KEPT = 100;
/** Bounded buffer for the top-level build-entries list. */
const MAX_BUILD_ENTRIES_KEPT = 200;
/** Per-row bounded log-tail length. Architecture: default 100 lines. */
const MAX_ROW_LOG_LINES = 100;

// -----------------------------------------------------------------------------
// Pure reducer
// -----------------------------------------------------------------------------

/**
 * Pure projection reducer. One event in, one new state out. All field
 * writes preserve `readonly` invariants by constructing fresh
 * objects/arrays rather than mutating.
 *
 * The `tag` switch is exhaustive against `EngineEvent['tag']`; the
 * trailing `_exhaustive: never` causes TS to flag any new tag that
 * isn't handled here.
 */
export const applyEvent = (state: SubscribableState, event: EngineEvent): SubscribableState => {
	// Every event advances `lastEvent.at`. `lastEvent.seq` is bumped at
	// the `updateRef` wrapper, not here — this reducer is pure data.
	const withTouched = (next: Partial<SubscribableState>): SubscribableState => ({
		...state,
		...next,
		lastEvent: { seq: state.lastEvent.seq, at: eventAt(event) ?? state.lastEvent.at },
	});

	// Lifecycle-shaped events flow through the typed `LifecycleFact`
	// bridge — the projection consumes the merge-not-replace fact
	// instead of writing each lifecycle field independently. Non-
	// lifecycle events take their original specialised paths below.
	const fact = factFromEvent(event);
	if (fact !== null) {
		return withTouched({
			rows: upsertRow(state.rows, fact.pluginKey as PluginKey, (row) =>
				applyLifecycleFact(row, fact.delta),
			),
		});
	}

	switch (event.tag) {
		case 'lifecycle.statusChanged':
		case 'lifecycle.phaseSet':
			// Handled above via `factFromEvent` — kept in the switch for
			// `_exhaustive` discipline.
			return withTouched({});

		case 'log.appended':
			return withTouched({
				rows: upsertRow(state.rows, event.pluginKey, (row) =>
					appendLogLine(row, event.line, event.level),
				),
			});

		case 'endpoint.registered':
			return withTouched({
				endpoints: upsertEndpoint(state.endpoints, event.endpoint),
				rows: attachEndpoint(state.rows, event.endpoint),
			});

		case 'account.updated':
			return withTouched({
				accounts: upsertAccount(state.accounts, event.account),
			});

		case 'package.updated':
			return withTouched({
				packages: upsertPackage(state.packages, event.package),
			});

		case 'endpoint.released':
			// Renderer projection keeps endpoint history as last-known
			// operator affordance. A released service may no longer be
			// reachable, but hiding the URL during shutdown/restart makes
			// the TUI lose the most useful debugging handle.
			return withTouched({});

		case 'strategy.registered':
		case 'strategy.unregistered':
		case 'manifest.flushed':
		case 'codegen.emitted':
		case 'snapshot.captureStarted':
		case 'snapshot.captureProgress':
		case 'snapshot.captureSkipped':
		case 'snapshot.captureFailed':
		case 'snapshot.captured':
		case 'snapshot.restored':
			// Engine-internal events that don't carry a projection slice
			// — surfaced on the live event stream for renderers that care,
			// but contribute no field to the subscribable state. (Adding
			// a projection field for any of these requires an architecture
			// revision per G2.)
			return withTouched({});

		case 'shutdown.escalated':
			return withTouched({
				cycle: { ...state.cycle, phase: 'shutting-down' },
			});

		case 'error.reported':
			return withTouched({
				errors: pushBounded(state.errors, event.error, MAX_ERRORS_KEPT),
				rows: event.error.pluginKey
					? upsertRow(state.rows, event.error.pluginKey, (row) => ({
							...row,
							lastError: event.error,
						}))
					: state.rows,
			});

		case 'build.statusChanged':
			return withTouched({
				stackBuild: pushBounded(state.stackBuild, event.entry, MAX_BUILD_ENTRIES_KEPT),
			});

		case 'restart.requested':
			return withTouched({
				cycle: { ...state.cycle, phase: 'restarting' },
				rows:
					event.target === 'stack'
						? state.rows.map((r) => ({ ...r, selectiveRestartHighlight: false }))
						: state.rows.map((r) =>
								r.key === (event.target as { pluginKey: PluginKey }).pluginKey
									? { ...r, selectiveRestartHighlight: true }
									: r,
							),
			});

		case 'restart.completed':
			return withTouched({
				cycle: { ...state.cycle, phase: 'running' },
				rows: state.rows.map((r) => ({ ...r, selectiveRestartHighlight: false })),
			});

		case 'engine.orchestrator.dispatchFailed':
			// Orchestrator-side dispatch failure surfaced for renderers /
			// log consumers; carries no projection slice (the originating
			// plugin remains in its current lifecycle state — sink failure
			// is orchestrator-fault, not plugin-fault).
			return withTouched({});

		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return state;
		}
	}
};

// -----------------------------------------------------------------------------
// Engine-side mutators (not driven by EngineEvent)
// -----------------------------------------------------------------------------

/**
 * Replace `identity` on the projection. Called once at boot per cycle;
 * does NOT change on hot-restart.
 */
export const setIdentity = (
	state: SubscribableState,
	identity: SubscribableState['identity'],
): SubscribableState => ({ ...state, identity });

/**
 * Bump the cycle counter. Called at the start of each engine cycle.
 * Resets only fields the architecture says are per-cycle:
 *   - `cycle.id`, `cycle.startedAt`, `cycle.phase`
 *   - per-row `selectiveRestartHighlight`
 * The error log, endpoints, build log, and `lastEvent.seq` are
 * intentionally preserved across cycles so the renderer sees
 * continuous history.
 */
export const bumpCycle = (
	state: SubscribableState,
	now: number,
	phase: SubscribableState['cycle']['phase'] = 'booting',
): SubscribableState => ({
	...state,
	cycle: { id: state.cycle.id + 1, startedAt: now, phase },
	rows: state.rows.map((r) => ({ ...r, selectiveRestartHighlight: false })),
});

/**
 * Register (or replace) a row in the projection. The supervisor wires
 * the call in.
 */
export const declareRow = (state: SubscribableState, row: Row): SubscribableState => {
	const idx = state.rows.findIndex((r) => r.key === row.key);
	if (idx === -1) return { ...state, rows: [...state.rows, row] };
	const next = state.rows.slice();
	next[idx] = row;
	return { ...state, rows: next };
};

/**
 * Drop a row. Used during selective-restart when a plugin is being
 * removed (rare; most restarts replay the same row).
 */
export const dropRow = (state: SubscribableState, key: PluginKey): SubscribableState => ({
	...state,
	rows: state.rows.filter((r) => r.key !== key),
});

export const declareAccount = (
	state: SubscribableState,
	account: AccountProjection,
): SubscribableState => ({
	...state,
	accounts: upsertAccount(state.accounts, account),
});

export const declarePackage = (
	state: SubscribableState,
	pkg: PackageProjection,
): SubscribableState => ({
	...state,
	packages: upsertPackage(state.packages, pkg),
});

// -----------------------------------------------------------------------------
// SubscriptionRef-driven updaters
// -----------------------------------------------------------------------------

/**
 * Apply an `EngineEvent` to the ref, bumping the sequence number
 * atomically. The seq is monotonic per process and survives cycle
 * boundaries.
 *
 * Uses `state.lastEvent.seq + 1` for monotonic per-process counts.
 */
export const updateRef = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	event: EngineEvent,
): Effect.Effect<void> =>
	SubscriptionRef.update(ref, (state) => {
		const next = applyEvent(state, event);
		return {
			...next,
			lastEvent: { seq: state.lastEvent.seq + 1, at: next.lastEvent.at },
		};
	});

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const eventAt = (event: EngineEvent): number | null => {
	if ('at' in event) return event.at;
	// Events whose payload nests `at` (endpoint, error, build): pull it
	// up. Discriminating purely on `tag` keeps this exhaustive.
	switch (event.tag) {
		case 'endpoint.registered':
			return event.endpoint.registeredAt;
		case 'error.reported':
			return event.error.at;
		case 'build.statusChanged':
			return event.entry.startedAt;
		default:
			return null;
	}
};

const upsertRow = (
	rows: ReadonlyArray<Row>,
	key: PluginKey,
	update: (row: Row) => Row,
): ReadonlyArray<Row> => {
	const idx = rows.findIndex((r) => r.key === key);
	if (idx === -1) {
		// Row was never declared. We do NOT auto-create — declaration is
		// the plugin's job. Drop the event silently; the renderer can't
		// render a row it doesn't know about.
		return rows;
	}
	const next = rows.slice();
	next[idx] = update(rows[idx]!);
	return next;
};

const appendLogLine = (row: Row, line: string, level: 'info' | 'warn' | 'error'): Row => {
	const nextLines = [...row.logTail.lines, line];
	const truncated = nextLines.length > MAX_ROW_LOG_LINES;
	const trimmed = truncated ? nextLines.slice(-MAX_ROW_LOG_LINES) : nextLines;
	return {
		...row,
		logTail: {
			lines: trimmed,
			level: maxLevel(row.logTail.level, level),
			truncated: row.logTail.truncated || truncated,
		},
	};
};

const maxLevel = (
	a: 'info' | 'warn' | 'error',
	b: 'info' | 'warn' | 'error',
): 'info' | 'warn' | 'error' => {
	const rank = { info: 0, warn: 1, error: 2 } as const;
	return rank[a] >= rank[b] ? a : b;
};

const upsertEndpoint = (
	endpoints: ReadonlyArray<Endpoint>,
	endpoint: Endpoint,
): ReadonlyArray<Endpoint> => {
	const idx = endpoints.findIndex((e) => e.endpointKey === endpoint.endpointKey);
	if (idx === -1) return [...endpoints, endpoint];
	const next = endpoints.slice();
	next[idx] = endpoint;
	return next;
};

const upsertAccount = (
	accounts: ReadonlyArray<AccountProjection>,
	account: AccountProjection,
): ReadonlyArray<AccountProjection> => {
	const idx = accounts.findIndex((entry) => entry.key === account.key);
	if (idx === -1) return [...accounts, account];
	const next = accounts.slice();
	next[idx] = {
		...accounts[idx]!,
		...account,
		funding: {
			...accounts[idx]!.funding,
			...account.funding,
		},
	};
	return next;
};

const upsertPackage = (
	packages: ReadonlyArray<PackageProjection>,
	pkg: PackageProjection,
): ReadonlyArray<PackageProjection> => {
	const idx = packages.findIndex((entry) => entry.key === pkg.key);
	if (idx === -1) return [...packages, pkg];
	const next = packages.slice();
	next[idx] = {
		...packages[idx]!,
		...pkg,
	};
	return next;
};

const attachEndpoint = (rows: ReadonlyArray<Row>, endpoint: Endpoint): ReadonlyArray<Row> => {
	// Endpoint -> Row link is `endpointKey` derived from `pluginKey` + dispatchId.
	// The plugin that owns the endpoint must have a row; we look it up by
	// the endpoint's pluginKey via a structured field. The current
	// `Endpoint` shape (from projection.ts) doesn't carry pluginKey in
	// the projection slice — it's derivable from `endpointKey` (prefix match).
	const probableKey = endpoint.endpointKey;
	return rows.map((row) =>
		probableKey.startsWith(row.key)
			? row.endpoints.includes(probableKey)
				? row
				: { ...row, endpoints: [...row.endpoints, probableKey] }
			: row,
	);
};

const pushBounded = <T>(xs: ReadonlyArray<T>, value: T, max: number): ReadonlyArray<T> => {
	const next = [...xs, value];
	return next.length > max ? next.slice(-max) : next;
};

// Re-export the bounded-capacity constants for tests / docs.
export const __capacities = {
	MAX_ERRORS_KEPT,
	MAX_BUILD_ENTRIES_KEPT,
	MAX_ROW_LOG_LINES,
} as const;

// Re-export referenced sub-types for downstream consumers (tests,
// renderer-side wrappers) so they don't reach into substrate/
// directly.
export type {
	AccountProjection,
	BuildEntry,
	Endpoint,
	LifecycleStatus,
	PackageProjection,
	Row,
	StructuredError,
};
