import type { EngineEvent } from '../../substrate/events.ts';
import { errorSummaryFor, labelForRow, type ColorToken } from './display-derivation.ts';

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

export const eventLogLineFromEvent = (event: EngineEvent, seq: number): EventLogLine | null => {
	const at = eventAt(event);
	const id = `${at}-${seq}-${event.tag}`;
	switch (event.tag) {
		case 'log.appended':
			if (event.level === 'info' || isRedundantPluginLog(event.line)) return null;
			return line({
				id,
				at,
				level: event.level,
				scope: labelForRow(event.pluginKey),
				scopeColor: colorForPluginKey(event.pluginKey),
				message: event.line,
			});
		case 'error.reported':
			return line({
				id,
				level: event.error.severity === 'warn' ? 'warn' : 'error',
				at,
				scope: event.error.pluginKey === null ? 'Stack' : labelForRow(event.error.pluginKey),
				scopeColor:
					event.error.pluginKey === null ? 'white' : colorForPluginKey(event.error.pluginKey),
				message: `failed: ${errorSummaryFor(event.error)}`,
			});
		case 'build.statusChanged':
		case 'lifecycle.statusChanged':
		case 'lifecycle.phaseSet':
		case 'endpoint.registered':
		case 'account.updated':
		case 'package.updated':
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

const colorForPluginKey = (pluginKey: string): ColorToken => {
	const normalized = pluginKey.toLowerCase();
	if (normalized.includes('account')) return 'magenta';
	if (normalized.includes('package')) return 'blueBright';
	if (normalized.includes('action')) return 'magenta';
	if (normalized.includes('app') || normalized.includes('frontend')) return 'white';
	return 'cyan';
};
