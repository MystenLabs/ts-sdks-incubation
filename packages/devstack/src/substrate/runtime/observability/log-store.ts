// Cross-service queryable log store.
//
// The `Logger` service (logger.ts) keeps a bounded PER-TAG ring buffer that
// feeds the projection's per-row `logTail`. That surface is renderer-facing:
// one short tail per plugin row, no cross-service merge, no history, no
// server-side level/source filtering. The dashboard's Console "Logs" tab
// needs the opposite shape — a single append-only, cross-service stream the
// browser can filter by service / level / substring / time window.
//
// This store is that second surface. It is fed from the SAME source as the
// projection tail (the supervisor's `withEventPublishingLogger` wrapper taps
// every `Logger.log` call into here), so we do NOT double-spawn log readers
// or re-capture container output: there is one log-production path
// (`Logger.log`) and two consumers hang off it.
//
// Shape: one global bounded ring (last N records, append-only, monotonically
// increasing `seq`). Process-scoped — the backing `Ref` is created in the
// supervisor alongside `hub`/`commands`, so it survives `stack.restart`
// (only `cycle.id` bumps) exactly like the projection ref.
//
// Hot-path discipline: append is a single `Ref.update` that pushes onto an
// array and trims when it overflows. No I/O, no redaction (the upstream
// `Logger.log` already redacted the message + fields before calling here).

import { Context, Effect, Layer, Ref } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { LogLevel } from './logger.ts';

// -----------------------------------------------------------------------------
// Record shape
// -----------------------------------------------------------------------------

/** One queryable, cross-service log record. Plain data — the dashboard
 *  schema projects this directly. `service` is the resource/plugin key the
 *  line was logged under (or the bare tag when no plugin key was attached,
 *  e.g. the supervisor's own lines). */
export interface LogRecord {
	/** Monotonic per-process sequence. Stable cursor for the dashboard. */
	readonly seq: number;
	readonly timestampMillis: number;
	readonly level: LogLevel;
	/** Resource/plugin key (`postgres`, `deepbook/SUI_USDC`, …) or the bare
	 *  log tag when the line carried no plugin key. */
	readonly service: string;
	readonly message: string;
	/** Structured fields (already redacted upstream). */
	readonly fields: Readonly<Record<string, unknown>>;
}

/** Filter applied server-side before the records cross to the browser. Every
 *  field is optional; an absent field means "don't constrain on this axis". */
export interface LogFilter {
	/** Keep only records whose `service` is in this set (exact match). */
	readonly services?: ReadonlyArray<string>;
	/** Keep only records at one of these levels. */
	readonly levels?: ReadonlyArray<LogLevel>;
	/** Case-insensitive substring match against the message (and service). */
	readonly search?: string;
	/** Keep only records at/after this epoch-ms. */
	readonly sinceMillis?: number;
	/** Cap on returned records (most recent first). Defaults to the ring
	 *  capacity. */
	readonly limit?: number;
}

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Aggregate cross-service retention. Bounded so memory stays flat under a
 *  chatty stack; the projection tail keeps its own short per-row window. */
export const DEFAULT_LOG_CAPACITY = 5000;

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface LogStoreShape {
	/** Append a record. Called from the supervisor's logger tap on the hot
	 *  path — a single `Ref.update`, no I/O. */
	readonly append: (record: {
		readonly level: LogLevel;
		readonly service: string;
		readonly message: string;
		readonly fields?: Readonly<Record<string, unknown>>;
		readonly timestampMillis?: number;
	}) => Effect.Effect<void>;
	/** Query the ring with a filter. Returns most-recent-first, capped by
	 *  `filter.limit` (default = capacity). Never fails. */
	readonly query: (filter?: LogFilter) => Effect.Effect<ReadonlyArray<LogRecord>>;
	/** Distinct service keys currently in the ring (for filter dropdowns). */
	readonly services: Effect.Effect<ReadonlyArray<string>>;
}

export class LogStore extends Context.Service<LogStore, LogStoreShape>()(
	'@devstack/substrate/LogStore',
) {}

interface RingState {
	readonly records: ReadonlyArray<LogRecord>;
	readonly nextSeq: number;
}

/** Build a `LogStoreShape` over a freshly-created Ring `Ref`. The supervisor
 *  calls this (not the Layer) so the ring is process-scoped alongside the
 *  projection ref. `capacity` is injectable for tests. */
export const makeLogStore = (
	capacity: number = DEFAULT_LOG_CAPACITY,
): Effect.Effect<LogStoreShape> =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<RingState>({ records: [], nextSeq: 0 });

		const append: LogStoreShape['append'] = (record) =>
			Ref.update(ref, (state) => {
				const next: LogRecord = {
					seq: state.nextSeq,
					timestampMillis: record.timestampMillis ?? Date.now(),
					level: record.level,
					service: record.service,
					message: record.message,
					fields: record.fields ?? {},
				};
				const records = [...state.records, next];
				const trimmed = records.length > capacity ? records.slice(-capacity) : records;
				return { records: trimmed, nextSeq: state.nextSeq + 1 };
			});

		const query: LogStoreShape['query'] = (filter) =>
			Ref.get(ref).pipe(Effect.map((state) => applyLogFilter(state.records, filter, capacity)));

		const services: LogStoreShape['services'] = Ref.get(ref).pipe(
			Effect.map((state) => {
				const seen = new Set<string>();
				for (const r of state.records) seen.add(r.service);
				return [...seen].sort();
			}),
		);

		return LogStore.of({ append, query, services });
	});

/** Pure filter application — exported for tests. Records are stored
 *  oldest-first; we return newest-first (most useful for a log console) and
 *  cap to `limit`. */
export const applyLogFilter = (
	records: ReadonlyArray<LogRecord>,
	filter: LogFilter | undefined,
	capacity: number,
): ReadonlyArray<LogRecord> => {
	const serviceSet =
		filter?.services && filter.services.length > 0 ? new Set(filter.services) : null;
	const levelSet = filter?.levels && filter.levels.length > 0 ? new Set(filter.levels) : null;
	const search = filter?.search?.trim().toLowerCase();
	const since = filter?.sinceMillis;
	const limit = filter?.limit ?? capacity;

	const out: LogRecord[] = [];
	// Walk newest→oldest so we can stop early once `limit` is hit.
	for (let i = records.length - 1; i >= 0 && out.length < limit; i -= 1) {
		const r = records[i]!;
		if (serviceSet !== null && !serviceSet.has(r.service)) continue;
		if (levelSet !== null && !levelSet.has(r.level)) continue;
		if (since !== undefined && r.timestampMillis < since) continue;
		if (
			search !== undefined &&
			search.length > 0 &&
			!r.message.toLowerCase().includes(search) &&
			!r.service.toLowerCase().includes(search)
		) {
			continue;
		}
		out.push(r);
	}
	return out;
};

/** Layer form (for any caller that wants the store via a Layer rather than
 *  the supervisor-scoped `makeLogStore`). Uses the default capacity. */
export const layerLogStore: Layer.Layer<LogStore> = Layer.effect(LogStore, makeLogStore());

/** Coerce an arbitrary `pluginKey` (the upstream `Logger.log` tag carries an
 *  optional `PluginKey`) to the store's `service` string, falling back to the
 *  bare log tag when no plugin key is present. */
export const serviceKeyFor = (tag: string, pluginKey: PluginKey | null): string =>
	pluginKey === null ? tag : String(pluginKey);
