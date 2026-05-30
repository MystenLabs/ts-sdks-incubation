// Completed-span ring + recording Tracer.
//
// Devstack emits spans with `Effect.withSpan` all over the substrate
// (`acquire-node`, command names, background tasks, teardown, http handlers,
// …) carrying the canonical `devstack.*` attributes (see spans.ts). Until
// now no `Tracer` was provided, so those spans hit Effect's default no-op
// native tracer and evaporated — the dashboard's "Traces" tab had nothing to
// read.
//
// This module provides a minimal RECORDING tracer: it wraps Effect's
// `NativeSpan` and, when a span ends, projects it into a bounded ring the
// dashboard can query. The tracer is a drop-in for the default native tracer
// (it still produces real `Span` objects with parent/trace ids, so span
// propagation and any future OTel layer keep working) — it just also pushes
// the completed span into the ring on `end()`.
//
// Hot-path discipline: `span()` allocates one `NativeSpan` (same as the
// default). `end()` does one synchronous array push + bounded trim via a
// direct mutable array — NO Effect/Ref round-trip on the hot path, since
// `Tracer.span` / `Span.end` are synchronous and run on the fiber's critical
// path. The ring is a plain object captured in the closure; reads go through
// an Effect accessor for the service surface.
//
// Process-scoped: the ring object is created in the supervisor alongside the
// log store, so it survives `stack.restart`.

import { Context, Effect, Exit, Layer, Option, Tracer } from 'effect';

import { SpanAttr } from './spans.ts';

// -----------------------------------------------------------------------------
// Record shape
// -----------------------------------------------------------------------------

/** One completed span. Plain data; the dashboard schema projects it
 *  directly. `op` is the span name; `service` is derived from the
 *  `devstack.plugin` attribute (falling back to the span name's leading
 *  segment). */
export interface SpanRecord {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentId: string | null;
	/** Span name / operation (`acquire-node`, `lifecycle.supervisor.runCommand`, …). */
	readonly name: string;
	/** `devstack.plugin` attribute when present, else `null`. */
	readonly service: string | null;
	readonly startMillis: number;
	readonly durationMillis: number;
	readonly status: 'ok' | 'error';
	/** Flattened span attributes (string-coerced values). */
	readonly attributes: Readonly<Record<string, string>>;
}

/** Server-side span filter. Every field optional. */
export interface SpanFilter {
	/** Keep only spans whose derived `service` is in this set. */
	readonly services?: ReadonlyArray<string>;
	/** Keep only spans with one of these statuses. */
	readonly statuses?: ReadonlyArray<'ok' | 'error'>;
	/** Case-insensitive substring match against the span name (and service). */
	readonly search?: string;
	/** Keep only spans that STARTED at/after this epoch-ms. */
	readonly sinceMillis?: number;
	/** Cap on returned spans (most recent first). */
	readonly limit?: number;
}

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Completed-span retention. Bounded so a long-lived stack stays flat. */
export const DEFAULT_SPAN_CAPACITY = 2000;

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface SpanStoreShape {
	/** Query the ring with a filter (most-recent-first). Never fails. */
	readonly query: (filter?: SpanFilter) => Effect.Effect<ReadonlyArray<SpanRecord>>;
	/** Distinct derived service keys currently in the ring. */
	readonly services: Effect.Effect<ReadonlyArray<string>>;
	/** The recording `Tracer` to provide into the supervisor's effect
	 *  context. Wraps Effect's native tracer; records on span `end()`. */
	readonly tracer: Tracer.Tracer;
}

export class SpanStore extends Context.Service<SpanStore, SpanStoreShape>()(
	'@devstack/substrate/SpanStore',
) {}

// -----------------------------------------------------------------------------
// Plain mutable ring (hot-path-cheap; no Ref round-trip in `end()`)
// -----------------------------------------------------------------------------

interface Ring {
	records: SpanRecord[];
	readonly capacity: number;
}

const pushRecord = (ring: Ring, record: SpanRecord): void => {
	ring.records.push(record);
	if (ring.records.length > ring.capacity) {
		// Drop the oldest. `shift` is O(n) but spans complete far slower than
		// logs and the capacity is bounded; keep it simple over a head index.
		ring.records.shift();
	}
};

const NANOS_PER_MILLI = 1_000_000n;
const nanosToMillis = (n: bigint): number => Number(n / NANOS_PER_MILLI);

/** Derive the dashboard `service` for a span: prefer the canonical
 *  `devstack.plugin` attribute, else fall back to the span name. Plugin
 *  spans without the attribute use the dotted `devstack.plugin.<name>.…`
 *  convention, so we special-case that prefix to recover `<name>` (e.g.
 *  `devstack.plugin.postgres.acquire` → `postgres`) instead of bucketing
 *  every plugin span under the shared `devstack` head. Other namespaced
 *  spans fall back to the leading dotted/slashed segment
 *  (`lifecycle.supervisor.runCommand` → `lifecycle`). `null` when neither
 *  is informative. */
const PLUGIN_SPAN_PREFIX = 'devstack.plugin.';
const deriveService = (name: string, attributes: ReadonlyMap<string, unknown>): string | null => {
	const plugin = attributes.get(SpanAttr.plugin);
	if (typeof plugin === 'string' && plugin.length > 0) return plugin;
	if (name.startsWith(PLUGIN_SPAN_PREFIX)) {
		// `devstack.plugin.<name>.<op>` → `<name>` (the segment after the prefix).
		const rest = name.slice(PLUGIN_SPAN_PREFIX.length);
		const pluginName = rest.split(/[./]/, 1)[0];
		if (pluginName !== undefined && pluginName.length > 0) return pluginName;
	}
	const head = name.split(/[./]/, 1)[0];
	return head !== undefined && head.length > 0 && head !== name ? head : null;
};

const flattenAttributes = (attributes: ReadonlyMap<string, unknown>): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [k, v] of attributes) {
		out[k] = typeof v === 'string' ? v : String(v);
	}
	return out;
};

/** Build the recording span from the native span at end time. */
const recordFrom = (
	span: Tracer.NativeSpan,
	endTime: bigint,
	exit: Exit.Exit<unknown, unknown>,
): SpanRecord => {
	const parent = Option.getOrUndefined(span.parent);
	const startMillis = nanosToMillis(span.startTime);
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		parentId: parent?.spanId ?? null,
		name: span.name,
		service: deriveService(span.name, span.attributes),
		startMillis,
		durationMillis: Math.max(0, nanosToMillis(endTime) - startMillis),
		status: Exit.isSuccess(exit) ? 'ok' : 'error',
		attributes: flattenAttributes(span.attributes),
	};
};

/** A `Tracer` that builds Effect's `NativeSpan` (so parent/trace propagation
 *  and attribute capture behave exactly like the default) and records each
 *  span into `ring` when it ends. */
const recordingTracer = (ring: Ring): Tracer.Tracer =>
	Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			const originalEnd = span.end.bind(span);
			span.end = (endTime, exit) => {
				originalEnd(endTime, exit);
				// Guard: recording must never break tracing.
				try {
					pushRecord(ring, recordFrom(span, endTime, exit));
				} catch {
					/* swallow — observability is best-effort */
				}
			};
			return span;
		},
	});

/** Build a `SpanStoreShape` over a fresh ring. The supervisor calls this so
 *  the ring is process-scoped. `capacity` is injectable for tests. */
export const makeSpanStore = (
	capacity: number = DEFAULT_SPAN_CAPACITY,
): Effect.Effect<SpanStoreShape> =>
	Effect.sync(() => {
		const ring: Ring = { records: [], capacity };

		const query: SpanStoreShape['query'] = (filter) =>
			Effect.sync(() => applySpanFilter(ring.records, filter, capacity));

		const services: SpanStoreShape['services'] = Effect.sync(() => {
			const seen = new Set<string>();
			for (const r of ring.records) if (r.service !== null) seen.add(r.service);
			return [...seen].sort();
		});

		return SpanStore.of({ query, services, tracer: recordingTracer(ring) });
	});

/** Pure filter application — exported for tests. Stored oldest-first; we
 *  return newest-first and cap to `limit`. */
export const applySpanFilter = (
	records: ReadonlyArray<SpanRecord>,
	filter: SpanFilter | undefined,
	capacity: number,
): ReadonlyArray<SpanRecord> => {
	const serviceSet =
		filter?.services && filter.services.length > 0 ? new Set(filter.services) : null;
	const statusSet =
		filter?.statuses && filter.statuses.length > 0 ? new Set(filter.statuses) : null;
	const search = filter?.search?.trim().toLowerCase();
	const since = filter?.sinceMillis;
	const limit = filter?.limit ?? capacity;

	const out: SpanRecord[] = [];
	for (let i = records.length - 1; i >= 0 && out.length < limit; i -= 1) {
		const r = records[i]!;
		if (serviceSet !== null && (r.service === null || !serviceSet.has(r.service))) continue;
		if (statusSet !== null && !statusSet.has(r.status)) continue;
		if (since !== undefined && r.startMillis < since) continue;
		if (
			search !== undefined &&
			search.length > 0 &&
			!r.name.toLowerCase().includes(search) &&
			!(r.service ?? '').toLowerCase().includes(search)
		) {
			continue;
		}
		out.push(r);
	}
	return out;
};

/** Layer form (default capacity) for callers that want the store via a Layer. */
export const layerSpanStore: Layer.Layer<SpanStore> = Layer.effect(SpanStore, makeSpanStore());
