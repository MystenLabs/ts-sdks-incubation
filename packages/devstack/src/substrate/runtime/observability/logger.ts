// Structured per-tag log buffer.
//
// Architecture § L0 Observability primitives: "structured log buffer,
// span/annotation conventions, cause walker (shared with renderers,
// not duplicated)".
//
// A typed Service for per-tag logging. Plugins acquire a `Logger` and publish lines;
// the substrate keeps each line in a bounded per-tag ring buffer and
// mirrors it into Effect's structured logging via `Effect.log*`.
// Operator-level lines are also projected into the typed event stream
// by the supervisor wrapper.
//
// Per-tag atomicity is guaranteed by `Ref.update` on the per-tag
// buffer — single-fiber updates are linearizable and the buffer
// reads are snapshot-consistent. Cross-process atomicity (when the
// same log lands in two devstack processes via a shared file)
// is delegated to the cross-process lock primitive in
// `../cross-process/stack-lock.ts`.

import { Context, Effect, Layer, Ref } from 'effect';

import type { PluginKey } from '../../brand.ts';
import { SpanAttr } from './spans.ts';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Closed level set. Mirrors the projection's row.logTail.level
 *  vocabulary, plus `debug` / `trace` for lifecycle diagnostics that
 *  should stay in buffers / Effect logs rather than the renderer's
 *  operator event stream. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A buffered log line. Plain data; the projection's `Row.logTail`
 *  derives from this. Structured fields live in `fields` for
 *  observability consumers that want richer than a string. */
export interface LogLine {
	readonly tag: string;
	readonly pluginKey: PluginKey | null;
	readonly level: LogLevel;
	readonly message: string;
	readonly fields: Readonly<Record<string, unknown>>;
	readonly at: number;
}

export interface LogPayload {
	readonly level: LogLevel;
	readonly message: string;
	readonly fields?: Readonly<Record<string, unknown>>;
}

/** Bounded ring-buffer for a single tag. */
export interface TagBuffer {
	readonly lines: ReadonlyArray<LogLine>;
	readonly truncated: boolean;
}

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Per-tag retention. Matches the projection's
 *  `MAX_ROW_LOG_LINES` default. */
export const DEFAULT_MAX_LINES_PER_TAG = 100;

/** Hard cap on a single log line in bytes (UTF-8). Lines past this
 *  are truncated with an ellipsis. */
export const MAX_LINE_BYTES = 16 * 1024;

// -----------------------------------------------------------------------------
// Logger service
// -----------------------------------------------------------------------------

/**
 * Structured per-tag logger. One instance per stack (or per process —
 * provided via `layerLogger`). Plugins acquire it from Context.
 *
 * Discipline:
 *   - The tag is the only thing the logger discriminates on. It is
 *     not a service name; it's whatever the publishing fiber picked
 *     (typically `pluginKey + '/' + sub-tag`).
 *   - Atomic per-tag writes: `Ref.update` on a `ReadonlyMap` of
 *     `tag → TagBuffer`. Two fibers logging to the same tag interleave
 *     by Ref linearization, not by lost updates.
 *   - Structured fields: anything serializable. The cascade formatter
 *     (see `cascade-formatter.ts`) renders the fields verbatim.
 */
/**
 * Public shape of the Logger service. Plugins / supervisor depend on
 * this interface; the concrete Layer below builds an instance.
 */
export interface LoggerShape {
	readonly log: (
		tag: string,
		pluginKey: PluginKey | null,
		payload: LogPayload,
	) => Effect.Effect<void>;
	readonly readTag: (tag: string) => Effect.Effect<TagBuffer>;
	readonly readAll: Effect.Effect<ReadonlyMap<string, TagBuffer>>;
	readonly clearTag: (tag: string) => Effect.Effect<void>;
}

export class Logger extends Context.Service<Logger, LoggerShape>()('@devstack/substrate/Logger') {}

/** Layer that constructs the per-stack Logger. Stateful (holds the
 *  per-tag ring buffers in a Ref); the substrate provides one per
 *  stack-scope. */
export const layerLogger: Layer.Layer<Logger> = Layer.effect(
	Logger,
	Effect.gen(function* () {
		const buffers = yield* Ref.make<ReadonlyMap<string, TagBuffer>>(new Map());

		const truncateLine = (s: string): string =>
			s.length > MAX_LINE_BYTES ? `${s.slice(0, MAX_LINE_BYTES)}…[truncated]` : s;

		const appendInternal = (line: LogLine): Effect.Effect<void> =>
			Ref.update(buffers, (map) => {
				const prev = map.get(line.tag) ?? { lines: [], truncated: false };
				const nextLines = [...prev.lines, line];
				const overflow = nextLines.length > DEFAULT_MAX_LINES_PER_TAG;
				const trimmed = overflow ? nextLines.slice(-DEFAULT_MAX_LINES_PER_TAG) : nextLines;
				const nextMap = new Map(map);
				nextMap.set(line.tag, { lines: trimmed, truncated: prev.truncated || overflow });
				return nextMap;
			});

		/** Log a line under `tag`. Atomic per-tag. */
		const log = Effect.fn('Logger.log')(function* (
			tag: string,
			pluginKey: PluginKey | null,
			payload: LogPayload,
		) {
			const line: LogLine = {
				tag,
				pluginKey,
				level: payload.level,
				message: truncateLine(payload.message),
				fields: payload.fields ?? {},
				at: Date.now(),
			};
			yield* appendInternal(line);
			// Mirror to Effect's structured logger so OTEL exporters see
			// the line too. The bounded buffer is the renderer-facing
			// surface; Effect's logger is the observability-pipeline
			// surface.
			yield* logViaEffect(line);
		});

		/** Read the current snapshot of a single tag's buffer. Used by
		 *  the projection updater when a row is created mid-stack. */
		const readTag = (tag: string): Effect.Effect<TagBuffer> =>
			Ref.get(buffers).pipe(Effect.map((map) => map.get(tag) ?? { lines: [], truncated: false }));

		/** Read every tag's current snapshot. Used by snapshot capture
		 *  + diagnostics. Bounded by aggregate retention. */
		const readAll = Ref.get(buffers);

		/** Drop the buffer for a tag. Used when a plugin row is removed. */
		const clearTag = (tag: string): Effect.Effect<void> =>
			Ref.update(buffers, (map) => {
				if (!map.has(tag)) return map;
				const next = new Map(map);
				next.delete(tag);
				return next;
			});

		return Logger.of({ log, readTag, readAll, clearTag });
	}),
);

// -----------------------------------------------------------------------------
// Effect-logger bridge
// -----------------------------------------------------------------------------

const logViaEffect = (line: LogLine): Effect.Effect<void> => {
	const annotated = Effect.annotateLogs({
		[SpanAttr.logTag]: line.tag,
		[SpanAttr.plugin]: line.pluginKey ?? '(none)',
		...line.fields,
	});
	switch (line.level) {
		case 'trace':
			return Effect.logTrace(line.message).pipe(annotated);
		case 'debug':
			return Effect.logDebug(line.message).pipe(annotated);
		case 'info':
			return Effect.logInfo(line.message).pipe(annotated);
		case 'warn':
			return Effect.logWarning(line.message).pipe(annotated);
		case 'error':
			return Effect.logError(line.message).pipe(annotated);
		case 'fatal':
			return Effect.logFatal(line.message).pipe(annotated);
		default: {
			const _exhaustive: never = line.level;
			void _exhaustive;
			return Effect.void;
		}
	}
};
