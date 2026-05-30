import type { EngineEvent } from '../../substrate/events.ts';
import type { RowSection } from '../../substrate/projection.ts';
import {
	errorSummaryFor,
	labelForRow,
	sectionColor,
	type ColorToken,
} from './display-derivation.ts';
import { eventAt } from '../../substrate/event-time.ts';

export interface EventLogLine {
	readonly id: string;
	readonly time: string;
	readonly scope: string;
	readonly scopeColor: ColorToken;
	readonly message: string;
	readonly text: string;
	readonly level: 'info' | 'warn' | 'error';
}

export const MAX_EVENT_LOG_LINES = 200;

/** Pure: lookup a row's plugin-declared section by `pluginKey`. The
 *  event log accepts this as a parameter rather than computing it
 *  itself — the substrate forbids the renderer from pattern-matching
 *  plugin-name substrings. Callers (e.g. `app.tsx`) build the lookup
 *  from the live `state.rows` projection. */
export type SectionLookup = (pluginKey: string) => RowSection | undefined;

export const eventLogLineFromEvent = (
	event: EngineEvent,
	seq: number,
	sectionLookup: SectionLookup = () => undefined,
): EventLogLine | null => {
	const at = eventAt(event);
	const id = `${at}-${seq}-${event.tag}`;
	const scopeColorFor = (pluginKey: string): ColorToken =>
		sectionColor(sectionLookup(pluginKey) ?? 'other');
	switch (event.tag) {
		case 'log.appended':
			if (event.level === 'info' || isRedundantPluginLog(event.line)) return null;
			return line({
				id,
				at,
				level: event.level,
				scope: labelForRow(event.pluginKey),
				scopeColor: scopeColorFor(event.pluginKey),
				message: event.line,
			});
		case 'error.reported':
			return line({
				id,
				level: event.error.severity === 'warn' ? 'warn' : 'error',
				at,
				scope: event.error.pluginKey === null ? 'Stack' : labelForRow(event.error.pluginKey),
				scopeColor: event.error.pluginKey === null ? 'white' : scopeColorFor(event.error.pluginKey),
				message: `failed: ${errorSummaryFor(event.error)}`,
			});
		case 'build.statusChanged':
		case 'lifecycle.statusChanged':
		case 'lifecycle.phaseSet':
		case 'endpoint.registered':
		case 'projection.updated':
			return null;
		case 'restart.requested':
			return line({
				id,
				level: 'warn',
				at,
				scope: 'Stack',
				scopeColor: 'white',
				message: `restart requested for ${targetLabel(event.target)}`,
			});
		case 'restart.completed':
			return line({
				id,
				level: 'info',
				at,
				scope: 'Stack',
				scopeColor: 'white',
				message: `restart completed for ${targetLabel(event.target)}`,
			});
		case 'shutdown.escalated':
			return line({
				id,
				level: 'warn',
				at,
				scope: 'Stack',
				scopeColor: 'white',
				message: `shutdown hard-kill escalated by ${event.signal} (exit ${event.exitCode})`,
			});
		case 'snapshot.captureStarted':
			return line({
				id,
				level: 'info',
				at,
				scope: 'Snapshot',
				scopeColor: 'blueBright',
				message: event.name === undefined ? 'capture started' : `capture started for ${event.name}`,
			});
		case 'snapshot.captureProgress':
			return null;
		case 'snapshot.captureSkipped':
			return line({
				id,
				level: 'warn',
				at,
				scope: 'Snapshot',
				scopeColor: 'blueBright',
				message: 'capture already running',
			});
		case 'snapshot.captureFailed':
			return line({
				id,
				level: 'error',
				at,
				scope: 'Snapshot',
				scopeColor: 'blueBright',
				message:
					event.name === undefined
						? `capture failed: ${event.summary}`
						: `capture failed for ${event.name}: ${event.summary}`,
			});
		case 'snapshot.captured':
			return line({
				id,
				level: 'info',
				at,
				scope: 'Snapshot',
				scopeColor: 'blueBright',
				message:
					event.name === undefined
						? `captured ${event.snapshotId}`
						: `captured ${event.name} (${event.snapshotId})`,
			});
		case 'snapshot.restored':
			return line({
				id,
				level: 'info',
				at,
				scope: 'Snapshot',
				scopeColor: 'blueBright',
				message: `restored ${event.snapshotId}`,
			});
		case 'engine.orchestrator.dispatchFailed':
			// A capability sink (e.g. `routable`) rejected, but the plugin is
			// left `ready` on purpose (non-fatal sink — see
			// dispatch-contributions.ts). Previously suppressed here, which
			// meant a live-dashboard operator saw a green stack with dead
			// RPC/wallet routing. Surface it as a warning so the failure is
			// visible; lead with the cause `_tag` when present so the line
			// names WHICH orchestrator broke.
			return line({
				id,
				level: 'warn',
				at,
				scope: labelForRow(event.pluginKey),
				scopeColor: scopeColorFor(event.pluginKey),
				message:
					event.causeType === undefined
						? `routing sink '${event.kind}' failed: ${event.message}`
						: `routing sink '${event.kind}' failed (${event.causeType}): ${event.message}`,
			});
		case 'endpoint.released':
		case 'strategy.registered':
		case 'strategy.unregistered':
		case 'manifest.flushed':
		case 'codegen.emitted':
			return null;
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return null;
		}
	}
};

export const shutdownRequestedLine = (at: number, seq: number): EventLogLine => ({
	id: `${at}-${seq}-shutdown.requested`,
	time: time(at),
	scope: 'Stack',
	scopeColor: 'white',
	message: 'shutdown requested; waiting for graceful stop',
	level: 'warn',
	text: `${time(at)} shutdown requested; waiting for graceful stop`,
});

export const appendEventLogLine = (
	lines: ReadonlyArray<EventLogLine>,
	next: EventLogLine | null,
): ReadonlyArray<EventLogLine> => {
	if (next === null) return lines;
	const appended = [...lines, next];
	return appended.length > MAX_EVENT_LOG_LINES ? appended.slice(-MAX_EVENT_LOG_LINES) : appended;
};

/**
 * Batched variant of `appendEventLogLine`: append many lines, slice to
 * the bound ONCE. The per-event variant rebuilt the array on every
 * call; a 100-event burst therefore allocated 100 arrays and ran the
 * `.slice(-MAX_EVENT_LOG_LINES)` projection 100 times. The plural form
 * collapses that to one allocation + one bound check — matching the
 * microtask-batched dispatch path in `app.tsx`.
 *
 * `nexts` may contain `null` entries (the same null-pass-through
 * contract as the singular form) — they're filtered before append.
 * Returns the input array unchanged when no real lines remain so
 * `setEventLog`'s referential-equality short-circuit still fires.
 */
export const appendEventLogLines = (
	lines: ReadonlyArray<EventLogLine>,
	nexts: ReadonlyArray<EventLogLine | null>,
): ReadonlyArray<EventLogLine> => {
	const real: Array<EventLogLine> = [];
	for (const line of nexts) {
		if (line !== null) real.push(line);
	}
	if (real.length === 0) return lines;
	const appended = lines.length === 0 ? real : [...lines, ...real];
	return appended.length > MAX_EVENT_LOG_LINES ? appended.slice(-MAX_EVENT_LOG_LINES) : appended;
};

const time = (at: number): string => new Date(at).toISOString().slice(11, 19);

const targetLabel = (target: 'stack' | { readonly pluginKey: string }): string =>
	target === 'stack' ? 'stack' : target.pluginKey;

const line = (input: {
	readonly id: string;
	readonly at: number;
	readonly level: EventLogLine['level'];
	readonly scope: string;
	readonly scopeColor: ColorToken;
	readonly message: string;
}): EventLogLine => {
	const renderedTime = time(input.at);
	return {
		id: input.id,
		time: renderedTime,
		scope: input.scope,
		scopeColor: input.scopeColor,
		message: input.message,
		level: input.level,
		text: `${renderedTime} ${input.scope}: ${input.message}`,
	};
};

const isRedundantPluginLog = (message: string): boolean => {
	const normalized = message.trim().toLowerCase();
	return (
		normalized === 'plugin acquire start' ||
		normalized === 'plugin ready' ||
		normalized === 'plugin acquire failed'
	);
};

// Scope-chip color is driven by `Row.section`, looked up via the
// `sectionLookup` argument the host (app.tsx / tests) constructs from
// the live projection. Keeps the renderer name-blind: it sees only the
// closed `RowSection` vocabulary (`service` / `package` / `account` /
// ...), never a substring of a plugin name. Plugin authors declare
// their section once via `definePlugin({ section })`.
