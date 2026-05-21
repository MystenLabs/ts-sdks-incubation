import type { EngineEvent } from '../../substrate/events.ts';
import { endpointLine, labelForRow } from './display-derivation.ts';

export interface EventLogLine {
	readonly id: string;
	readonly text: string;
	readonly level: 'info' | 'warn' | 'error';
}

export const MAX_EVENT_LOG_LINES = 200;

export const eventLogLineFromEvent = (event: EngineEvent, seq: number): EventLogLine | null => {
	const at = eventAt(event);
	const id = `${at}-${seq}-${event.tag}`;
	switch (event.tag) {
		case 'log.appended':
			return {
				id,
				level: event.level,
				text: `${time(at)} ${labelForRow(event.pluginKey, 'leaf-long-running')}: ${event.line}`,
			};
		case 'error.reported':
			return {
				id,
				level: event.error.severity === 'warn' ? 'warn' : 'error',
				text: `${time(at)} ${event.error.pluginKey ?? 'stack'} failed: ${event.error.summary}`,
			};
		case 'build.statusChanged':
			return {
				id,
				level: 'info',
				text: `${time(at)} ${event.entry.pluginKey ?? 'stack'} ${event.entry.phase} ${event.entry.progress}`,
			};
		case 'endpoint.registered':
			return {
				id,
				level: 'info',
				text: `${time(at)} endpoint ${endpointLine(event.endpoint)}`,
			};
		case 'lifecycle.statusChanged':
			return {
				id,
				level: event.to === 'failed' ? 'error' : 'info',
				text: `${time(at)} ${labelForRow(event.pluginKey, 'leaf-long-running')} ${event.from} -> ${event.to}`,
			};
		case 'lifecycle.phaseSet':
			if (event.phase === null || event.phase.trim().length === 0) return null;
			return {
				id,
				level: 'info',
				text: `${time(at)} ${labelForRow(event.pluginKey, 'leaf-long-running')} ${event.phase}`,
			};
		case 'restart.requested':
			return {
				id,
				level: 'warn',
				text: `${time(at)} restart requested for ${targetLabel(event.target)}`,
			};
		case 'restart.completed':
			return {
				id,
				level: 'info',
				text: `${time(at)} restart completed for ${targetLabel(event.target)}`,
			};
		case 'shutdown.escalated':
			return {
				id,
				level: 'warn',
				text: `${time(at)} shutdown escalated by ${event.signal} (exit ${event.exitCode})`,
			};
		case 'snapshot.captured':
			return { id, level: 'info', text: `${time(at)} snapshot captured ${event.snapshotId}` };
		case 'snapshot.restored':
			return { id, level: 'info', text: `${time(at)} snapshot restored ${event.snapshotId}` };
		case 'endpoint.released':
		case 'strategy.registered':
		case 'strategy.unregistered':
		case 'manifest.flushed':
		case 'codegen.emitted':
		case 'sibling.deduped':
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
	level: 'warn',
	text: `${time(at)} shutdown requested`,
});

export const appendEventLogLine = (
	lines: ReadonlyArray<EventLogLine>,
	next: EventLogLine | null,
): ReadonlyArray<EventLogLine> => {
	if (next === null) return lines;
	const appended = [...lines, next];
	return appended.length > MAX_EVENT_LOG_LINES ? appended.slice(-MAX_EVENT_LOG_LINES) : appended;
};

const eventAt = (event: EngineEvent): number => {
	if ('at' in event && typeof event.at === 'number') return event.at;
	switch (event.tag) {
		case 'endpoint.registered':
			return event.endpoint.registeredAt;
		case 'error.reported':
			return event.error.at;
		case 'build.statusChanged':
			return event.entry.startedAt;
		default:
			return Date.now();
	}
};

const time = (at: number): string => new Date(at).toISOString().slice(11, 19);

const targetLabel = (target: 'stack' | { readonly pluginKey: string }): string =>
	target === 'stack' ? 'stack' : target.pluginKey;
