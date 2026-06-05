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
// Shape: ONE BOUNDED RING PER SERVICE, keyed by the `service` string, plus a
// shared monotonic `seq` counter so cross-service queries order correctly.
// A single global ring (the previous design) let a chatty service evict
// everyone else — a crash loop spamming retries would push a quiet service's
// only error line out of the buffer before anyone could read it. Per-service
// rings give every service an independent retention window: a noisy service
// can only ever evict ITS OWN old lines.
//
// To keep total memory bounded under an unbounded set of distinct service
// keys, the number of rings is capped (`maxServices`). When that cap is hit
// and a brand-new service appears, one existing ring is evicted. Eviction is
// ERROR-AWARE: rings that contain an `error`/`fatal` record are preferred for
// RETENTION, so a crashed service's error trail is the last thing dropped.
// Among equally-(un)important rings we evict the one whose NEWEST record is
// oldest (LRU on most-recent activity). See `pickEvictionVictim`.
//
// Process-scoped — the backing `Ref` is created in the supervisor alongside
// `hub`/`commands`, so it survives `stack.restart` (only `cycle.id` bumps)
// exactly like the projection ref.
//
// Hot-path discipline: append is a single `Ref.update` that pushes onto the
// target service's array and trims when it overflows. No I/O, no redaction
// (the upstream `Logger.log` already redacted the message + fields before
// calling here). Ring eviction only runs on the FIRST sight of a new service
// once the cap is reached — not per-append.

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
	/** Cap on returned records (most recent first). Defaults to the merged
	 *  capacity (perServiceCapacity × maxServices). */
	readonly limit?: number;
}

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Per-service retention. Each service ring keeps at most this many records;
 *  a chatty service evicts only its own oldest lines. */
export const DEFAULT_PER_SERVICE_CAPACITY = 2000;

/** Max distinct service rings kept simultaneously. Caps total memory at
 *  `perServiceCapacity × maxServices` records. When exceeded, one ring is
 *  evicted (error-bearing rings preferred for retention — see
 *  `pickEvictionVictim`). */
export const DEFAULT_MAX_SERVICES = 256;

/** Env-var names for zero-config tuning. Read once when `makeLogStore` is
 *  called with no explicit config (the supervisor wiring site). Non-numeric
 *  or non-positive values fall back to the defaults. */
export const ENV_PER_SERVICE_CAPACITY = 'DEVSTACK_DASHBOARD_LOG_CAPACITY';
export const ENV_MAX_SERVICES = 'DEVSTACK_DASHBOARD_LOG_MAX_SERVICES';

/** Tunables for the per-service log store. Both optional; absent fields take
 *  the module defaults (or the corresponding env var, when resolved via
 *  `resolveLogStoreConfig`). */
export interface LogStoreConfig {
	/** Max records kept per service ring. Default {@link DEFAULT_PER_SERVICE_CAPACITY}. */
	readonly perServiceCapacity?: number;
	/** Max distinct service rings. Default {@link DEFAULT_MAX_SERVICES}. */
	readonly maxServices?: number;
}

interface ResolvedLogStoreConfig {
	readonly perServiceCapacity: number;
	readonly maxServices: number;
}

const positiveIntOr = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/** Resolve the effective config: explicit options win, then env vars, then
 *  module defaults. Pure given an `env` bag (defaults to `process.env`). */
export const resolveLogStoreConfig = (
	config: LogStoreConfig = {},
	env: Record<string, string | undefined> = process.env,
): ResolvedLogStoreConfig => ({
	perServiceCapacity:
		config.perServiceCapacity !== undefined && config.perServiceCapacity >= 1
			? Math.floor(config.perServiceCapacity)
			: positiveIntOr(env[ENV_PER_SERVICE_CAPACITY], DEFAULT_PER_SERVICE_CAPACITY),
	maxServices:
		config.maxServices !== undefined && config.maxServices >= 1
			? Math.floor(config.maxServices)
			: positiveIntOr(env[ENV_MAX_SERVICES], DEFAULT_MAX_SERVICES),
});

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface LogStoreShape {
	/** Append a record. Called from the supervisor's logger tap on the hot
	 *  path — a single `Ref.update`, no I/O. Routes to the per-service ring
	 *  (created on first sight of a service). */
	readonly append: (record: {
		readonly level: LogLevel;
		readonly service: string;
		readonly message: string;
		readonly fields?: Readonly<Record<string, unknown>>;
		readonly timestampMillis?: number;
	}) => Effect.Effect<void>;
	/** Query across all per-service rings with a filter. Returns
	 *  most-recent-first by `seq`, capped by `filter.limit`. Never fails. */
	readonly query: (filter?: LogFilter) => Effect.Effect<ReadonlyArray<LogRecord>>;
	/** Distinct service keys with a live ring (for filter dropdowns). */
	readonly services: Effect.Effect<ReadonlyArray<string>>;
}

export class LogStore extends Context.Service<LogStore, LogStoreShape>()(
	'@devstack/substrate/LogStore',
) {}

/** One service's bounded ring. `records` is oldest-first; `hasError` is a
 *  cached flag so eviction doesn't rescan the array (set when any
 *  `error`/`fatal` record is present after trimming). */
interface ServiceRing {
	readonly records: ReadonlyArray<LogRecord>;
	readonly hasError: boolean;
}

interface StoreState {
	/** Per-service rings. A `Map` so first-sight insertion / eviction is O(1)
	 *  and iteration order is insertion order (irrelevant — query sorts by
	 *  seq). */
	readonly rings: ReadonlyMap<string, ServiceRing>;
	readonly nextSeq: number;
}

const isErrorLevel = (level: LogLevel): boolean => level === 'error' || level === 'fatal';

/** Choose which service ring to evict when `maxServices` is reached and a new
 *  service appears. Policy (documented in the file header):
 *    1. Prefer to RETAIN rings that hold an `error`/`fatal` record — never
 *       drop a crashed/quiet service's only error trail while a chatty
 *       all-`info` ring exists. So victims are drawn from the error-free
 *       rings first; only if EVERY ring carries an error do we consider
 *       error-bearing ones.
 *    2. Within the candidate pool, evict the ring whose NEWEST record is
 *       oldest (LRU on most-recent activity) — the least recently active
 *       service. Ties broken by lowest newest-seq.
 *  Returns the service key to drop, or null when there are no rings. */
export const pickEvictionVictim = (rings: ReadonlyMap<string, ServiceRing>): string | null => {
	let victim: string | null = null;
	let victimNewestMillis = Number.POSITIVE_INFINITY;
	let victimNewestSeq = Number.POSITIVE_INFINITY;
	let victimHasError = true;

	for (const [service, ring] of rings) {
		const newest = ring.records[ring.records.length - 1];
		// An empty ring should never exist (we only create on append), but be
		// defensive: treat it as the most-evictable.
		const newestMillis = newest?.timestampMillis ?? Number.NEGATIVE_INFINITY;
		const newestSeq = newest?.seq ?? Number.NEGATIVE_INFINITY;
		const hasError = ring.hasError;

		// An error-free ring always beats an error-bearing one as a victim.
		if (victimHasError && !hasError) {
			victim = service;
			victimNewestMillis = newestMillis;
			victimNewestSeq = newestSeq;
			victimHasError = hasError;
			continue;
		}
		// Don't replace an error-free candidate with an error-bearing one.
		if (!victimHasError && hasError) continue;

		// Same error-class: prefer the one whose newest record is oldest.
		if (
			newestMillis < victimNewestMillis ||
			(newestMillis === victimNewestMillis && newestSeq < victimNewestSeq)
		) {
			victim = service;
			victimNewestMillis = newestMillis;
			victimNewestSeq = newestSeq;
			victimHasError = hasError;
		}
	}
	return victim;
};

/** Build a `LogStoreShape` over a freshly-created `Ref`. The supervisor calls
 *  this (not the Layer) so the rings are process-scoped alongside the
 *  projection ref. `config` is injectable for tests; with no `config` the
 *  env-var defaults apply. */
export const makeLogStore = (config: LogStoreConfig = {}): Effect.Effect<LogStoreShape> =>
	Effect.gen(function* () {
		const { perServiceCapacity, maxServices } = resolveLogStoreConfig(config);
		const ref = yield* Ref.make<StoreState>({ rings: new Map(), nextSeq: 0 });

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

				const rings = new Map(state.rings);
				const existing = rings.get(record.service);

				if (existing === undefined) {
					// First sight of this service — may need to evict to stay
					// under `maxServices`. Eviction runs ONLY here, not per
					// append.
					if (rings.size >= maxServices) {
						const victim = pickEvictionVictim(rings);
						if (victim !== null) rings.delete(victim);
					}
					rings.set(record.service, {
						records: [next],
						hasError: isErrorLevel(next.level),
					});
				} else {
					const merged = [...existing.records, next];
					const trimmed =
						merged.length > perServiceCapacity ? merged.slice(-perServiceCapacity) : merged;
					// Recompute `hasError` only when the trim could have dropped
					// the last error (i.e. an actual trim happened); otherwise the
					// flag only ever grows true.
					const hasError =
						trimmed.length < merged.length
							? trimmed.some((r) => isErrorLevel(r.level))
							: existing.hasError || isErrorLevel(next.level);
					rings.set(record.service, { records: trimmed, hasError });
				}

				return { rings, nextSeq: state.nextSeq + 1 };
			});

		const query: LogStoreShape['query'] = (filter) =>
			Ref.get(ref).pipe(Effect.map((state) => queryRings(state.rings, filter, perServiceCapacity)));

		const services: LogStoreShape['services'] = Ref.get(ref).pipe(
			Effect.map((state) => [...state.rings.keys()].sort()),
		);

		return LogStore.of({ append, query, services });
	});

// -----------------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------------

interface CompiledFilter {
	readonly serviceSet: ReadonlySet<string> | null;
	readonly levelSet: ReadonlySet<LogLevel> | null;
	readonly search: string | null;
	readonly since: number | undefined;
	readonly limit: number;
}

const compileFilter = (filter: LogFilter | undefined, defaultLimit: number): CompiledFilter => {
	const search = filter?.search?.trim().toLowerCase();
	return {
		serviceSet: filter?.services && filter.services.length > 0 ? new Set(filter.services) : null,
		levelSet: filter?.levels && filter.levels.length > 0 ? new Set(filter.levels) : null,
		search: search !== undefined && search.length > 0 ? search : null,
		since: filter?.sinceMillis,
		limit: filter?.limit ?? defaultLimit,
	};
};

const matches = (r: LogRecord, f: CompiledFilter): boolean => {
	if (f.serviceSet !== null && !f.serviceSet.has(r.service)) return false;
	if (f.levelSet !== null && !f.levelSet.has(r.level)) return false;
	if (f.since !== undefined && r.timestampMillis < f.since) return false;
	if (
		f.search !== null &&
		!r.message.toLowerCase().includes(f.search) &&
		!r.service.toLowerCase().includes(f.search)
	) {
		return false;
	}
	return true;
};

/** Merge all per-service rings into a single newest-first result. Each ring
 *  is oldest-first, so we run a k-way merge from the tail of each ring,
 *  emitting the globally-highest `seq` first and stopping once `limit` is
 *  filled. This is O(matched-prefix × ringCount) without materializing the
 *  whole universe — important when `limit` is small relative to total volume.
 *  Exported for tests. */
export const queryRings = (
	rings: ReadonlyMap<string, ServiceRing>,
	filter: LogFilter | undefined,
	perServiceCapacity: number,
): ReadonlyArray<LogRecord> => {
	const f = compileFilter(filter, perServiceCapacity * Math.max(rings.size, 1));
	if (f.limit <= 0) return [];

	// Cursor per ring, walking newest→oldest (from the end of each array).
	const arrays: ReadonlyArray<LogRecord>[] = [];
	const cursors: number[] = [];
	for (const ring of rings.values()) {
		if (ring.records.length > 0) {
			arrays.push(ring.records);
			cursors.push(ring.records.length - 1);
		}
	}

	const out: LogRecord[] = [];
	while (out.length < f.limit) {
		// Find the ring whose current cursor points at the highest seq.
		let bestRing = -1;
		let bestSeq = Number.NEGATIVE_INFINITY;
		for (let k = 0; k < arrays.length; k += 1) {
			const c = cursors[k]!;
			if (c < 0) continue;
			const seq = arrays[k]![c]!.seq;
			if (seq > bestSeq) {
				bestSeq = seq;
				bestRing = k;
			}
		}
		if (bestRing === -1) break; // all rings exhausted

		const c = cursors[bestRing]!;
		const r = arrays[bestRing]![c]!;
		cursors[bestRing] = c - 1;
		if (matches(r, f)) out.push(r);
	}
	return out;
};

/** Pure filter application over a flat oldest-first record array — retained
 *  for direct use / tests. Returns newest-first, capped to `limit`. */
export const applyLogFilter = (
	records: ReadonlyArray<LogRecord>,
	filter: LogFilter | undefined,
	capacity: number,
): ReadonlyArray<LogRecord> => {
	const f = compileFilter(filter, capacity);
	const out: LogRecord[] = [];
	for (let i = records.length - 1; i >= 0 && out.length < f.limit; i -= 1) {
		const r = records[i]!;
		if (matches(r, f)) out.push(r);
	}
	return out;
};

/** Layer form (for any caller that wants the store via a Layer rather than
 *  the supervisor-scoped `makeLogStore`). Uses the default/env config. */
export const layerLogStore: Layer.Layer<LogStore> = Layer.effect(LogStore, makeLogStore());

/** Coerce an arbitrary `pluginKey` (the upstream `Logger.log` tag carries an
 *  optional `PluginKey`) to the store's `service` string, falling back to the
 *  bare log tag when no plugin key is present. */
export const serviceKeyFor = (tag: string, pluginKey: PluginKey | null): string =>
	pluginKey === null ? tag : String(pluginKey);
