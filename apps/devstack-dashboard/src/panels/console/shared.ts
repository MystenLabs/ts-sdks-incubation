// Local shared helpers for the Console panel's three tabs. These are intentionally
// scoped to the Console (not promoted to `lib/`) — see Opportunities in the report.

import type { LogRecord } from '../../lib/api.ts';
import type { StatusToken } from '../../lib/derive.ts';

/** Cap on rendered log lines — the design's "virtualized-feel" budget. */
export const LOG_VISIBLE_CAP = 600;

/** Levels we surface in the level filter, in severity order, with dot tokens. */
export const LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string; token: StatusToken }> = [
	{ value: 'error', label: 'error', token: 'red' },
	{ value: 'warn', label: 'warn', token: 'yellow' },
	{ value: 'info', label: 'info', token: 'cyan' },
	{ value: 'debug', label: 'debug', token: 'white' },
];

/** Span status filter options, with dot tokens. */
export const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string; token: StatusToken }> = [
	{ value: 'ok', label: 'ok', token: 'green' },
	{ value: 'error', label: 'error', token: 'red' },
];

/** Message color for a log line, keyed off level (error red, warn yellow, else hi). */
export const logMessageColor = (level: string): string =>
	level === 'error' || level === 'fatal'
		? 'var(--c-red)'
		: level === 'warn'
			? 'var(--c-yellow)'
			: 'var(--tx-hi)';

/** True when a log line is at error/fatal severity (rendered unmissable). */
export const isErrorLevel = (level: string): boolean => level === 'error' || level === 'fatal';

/** Normalize an arbitrary backend level string to a LevelPill level. */
export const pillLevel = (level: string): 'info' | 'warn' | 'error' | 'debug' => {
	if (level === 'error' || level === 'fatal') return 'error';
	if (level === 'warn' || level === 'warning') return 'warn';
	if (level === 'debug' || level === 'trace') return 'debug';
	return 'info';
};

/** Stable React key for a log record (seq is monotonic per backend ring). */
export const logKey = (l: LogRecord): string => `${l.service}#${l.seq}`;

/** Render a record's structured fields as a compact `k=v k=v` mono string. */
export const formatFields = (fields: Record<string, unknown>): string =>
	Object.entries(fields)
		.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
		.join(' ');

/** Wall-clock `HH:MM:SS` (24h) for a log/span timestamp. */
export const clock24 = (millis: number): string =>
	new Date(millis).toLocaleTimeString('en', { hour12: false });
