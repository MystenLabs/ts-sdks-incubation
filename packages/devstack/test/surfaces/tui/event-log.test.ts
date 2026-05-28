import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { RowSection } from '../../../src/substrate/projection.ts';
import {
	appendEventLogLine,
	appendEventLogLines,
	eventLogLineFromEvent,
	type EventLogLine,
	MAX_EVENT_LOG_LINES,
	shutdownRequestedLine,
} from '../../../src/surfaces/tui/event-log.ts';

const AT = Date.parse('2026-05-19T20:11:32.001Z');

// Test stub for the section lookup the host (`app.tsx`) builds from
// the live projection. The renderer must NOT pattern-match plugin
// names — it consumes `row.section` via this lookup.
const fixedSection =
	(section: RowSection) =>
	(_pluginKey: string): RowSection =>
		section;

describe('event log derivation', () => {
	it('renders warning plugin logs as scoped activity lines', () => {
		const line = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('walrus'),
				line: 'publisher lost peer',
				level: 'warn',
				at: AT,
			},
			0,
			fixedSection('service'),
		);
		expect(line).toMatchObject({
			level: 'warn',
			time: '20:11:32',
			scope: 'Walrus',
			scopeColor: 'cyan',
			message: 'publisher lost peer',
			text: '20:11:32 Walrus: publisher lost peer',
		});
	});

	it('suppresses state already visible in the resource tables', () => {
		expect(
			eventLogLineFromEvent(
				{
					tag: 'log.appended',
					pluginKey: pluginKey('sui'),
					line: 'plugin ready',
					level: 'info',
					at: AT,
				},
				1,
			),
		).toBeNull();
		expect(
			eventLogLineFromEvent(
				{
					tag: 'lifecycle.statusChanged',
					pluginKey: pluginKey('sui'),
					from: 'acquiring',
					to: 'ready',
					at: AT,
				},
				2,
			),
		).toBeNull();
		expect(
			eventLogLineFromEvent(
				{
					tag: 'endpoint.registered',
					endpoint: {
						endpointKey: endpointKey('sui:rpc'),
						pluginKey: pluginKey('sui'),
						name: 'rpc',
						url: 'http://localhost:9000',
						displayUrl: null,
						wireProtocol: 'http',
						registeredAt: AT,
					},
				},
				3,
			),
		).toBeNull();
	});

	it('renders failures for the activity stream above the dashboard', () => {
		const error = eventLogLineFromEvent(
			{
				tag: 'error.reported',
				error: {
					at: AT,
					pluginKey: pluginKey('seal'),
					tag: 'BootError',
					summary: 'private content key server exited',
					chain: [
						'BootError: private content key server exited',
						'Docker: port is already allocated',
					],
					severity: 'error',
				},
			},
			1,
			fixedSection('service'),
		);
		expect(error?.level).toBe('error');
		expect(error?.scope).toBe('Seal');
		expect(error?.scopeColor).toBe('cyan');
		expect(error?.message).toContain('private content key server exited');
		expect(error?.message).toContain('port is already allocated');
	});

	it('colors the scope chip from the provided section lookup, not the pluginKey shape', () => {
		// The renderer is name-blind: chip color comes from the `RowSection`
		// the host (`app.tsx`) supplies for each pluginKey. With the
		// lookup returning `'package'` for a key that LOOKS like a
		// service, the scope chip should render as the `package` color
		// (`blueBright`) — proving no substring matching survives in the
		// renderer.
		const line = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('sui-looking-key#0'),
				line: 'something happened',
				level: 'warn',
				at: AT,
			},
			0,
			fixedSection('package'),
		);
		expect(line?.scopeColor).toBe('blueBright');
	});

	it('falls back to the "other" section color when the lookup has no entry', () => {
		// A pluginKey not yet projected (or one we deliberately filter)
		// should not crash the renderer or leak a default tied to plugin
		// names. The lookup returning `undefined` means: render with the
		// `'other'` color token.
		const line = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('unknown#0'),
				line: 'who am i',
				level: 'warn',
				at: AT,
			},
			0,
		);
		expect(line?.scopeColor).toBe('cyan'); // sectionColor('other') === 'cyan'
	});

	it('renders shutdown escalation as an operator warning', () => {
		const line = eventLogLineFromEvent(
			{
				tag: 'shutdown.escalated',
				signal: 'SIGINT',
				exitCode: 130,
				at: AT,
			},
			3,
		);
		expect(line).toMatchObject({
			level: 'warn',
			scope: 'Stack',
			message: 'shutdown hard-kill escalated by SIGINT (exit 130)',
			text: '20:11:32 Stack: shutdown hard-kill escalated by SIGINT (exit 130)',
		});
	});

	it('suppresses projection updates because projection state is table state', () => {
		expect(
			eventLogLineFromEvent(
				{
					tag: 'projection.updated',
					kind: 'account',
					key: 'account/alice',
					payload: {
						key: 'account/alice',
						rowKey: pluginKey('account/alice#1'),
						name: 'alice',
						address: '0xabc',
						scheme: 'ed25519',
						source: 'real',
						funding: { status: 'unknown', balanceMist: null, requestedMist: null },
						walletVisible: false,
						updatedAt: AT,
					},
					at: AT,
				},
				4,
			),
		).toBeNull();
	});

	it('renders graceful shutdown as a static operator warning', () => {
		expect(shutdownRequestedLine(AT, 4)).toMatchObject({
			level: 'warn',
			scope: 'Stack',
			scopeColor: 'white',
			message: 'shutdown requested; waiting for graceful stop',
			text: '20:11:32 shutdown requested; waiting for graceful stop',
		});
	});

	it('keeps the event log bounded', () => {
		const lines = Array.from({ length: MAX_EVENT_LOG_LINES + 2 }, (_, idx) => ({
			id: String(idx),
			time: '20:11:32',
			scope: 'Stack',
			scopeColor: 'white' as const,
			message: String(idx),
			text: String(idx),
			level: 'info' as const,
		})).reduce<ReadonlyArray<EventLogLine>>((acc, line) => appendEventLogLine(acc, line), []);
		expect(lines).toHaveLength(MAX_EVENT_LOG_LINES);
		expect(lines[0]?.id).toBe('2');
	});

	describe('appendEventLogLines — batched append', () => {
		const fakeLine = (id: number): EventLogLine => ({
			id: String(id),
			time: '20:11:32',
			scope: 'Stack',
			scopeColor: 'white',
			message: String(id),
			text: String(id),
			level: 'info',
		});

		it('appends a burst in a single pass, preserving order', () => {
			const burst = Array.from({ length: 100 }, (_, idx) => fakeLine(idx));
			const next = appendEventLogLines([], burst);
			expect(next).toHaveLength(100);
			expect(next[0]?.id).toBe('0');
			expect(next[99]?.id).toBe('99');
		});

		it('filters null entries (matches the singular form contract)', () => {
			const burst: ReadonlyArray<EventLogLine | null> = [
				fakeLine(0),
				null,
				fakeLine(1),
				null,
				fakeLine(2),
			];
			const next = appendEventLogLines([], burst);
			expect(next.map((l) => l.id)).toEqual(['0', '1', '2']);
		});

		it('returns the input array reference when the burst is all-null (lets setEventLog short-circuit)', () => {
			const start: ReadonlyArray<EventLogLine> = [fakeLine(0)];
			const next = appendEventLogLines(start, [null, null]);
			expect(next).toBe(start);
		});

		it('respects MAX_EVENT_LOG_LINES across the merged tail', () => {
			const existing = Array.from({ length: MAX_EVENT_LOG_LINES - 10 }, (_, idx) => fakeLine(idx));
			const burst = Array.from({ length: 50 }, (_, idx) => fakeLine(MAX_EVENT_LOG_LINES + idx));
			const next = appendEventLogLines(existing, burst);
			expect(next).toHaveLength(MAX_EVENT_LOG_LINES);
			// Oldest 40 trimmed from the head (existing had MAX-10, plus 50
			// new = MAX+40; tail bound keeps the most recent MAX).
			expect(next[0]?.id).toBe('40');
			expect(next[next.length - 1]?.id).toBe(String(MAX_EVENT_LOG_LINES + 49));
		});

		it('handles a single very large burst without going over the bound', () => {
			const burst = Array.from({ length: MAX_EVENT_LOG_LINES * 3 }, (_, idx) => fakeLine(idx));
			const next = appendEventLogLines([], burst);
			expect(next).toHaveLength(MAX_EVENT_LOG_LINES);
			// Last MAX entries preserved.
			expect(next[0]?.id).toBe(String(MAX_EVENT_LOG_LINES * 2));
			expect(next[next.length - 1]?.id).toBe(String(MAX_EVENT_LOG_LINES * 3 - 1));
		});
	});

	it('eventAt projects the producer-time, not a dequeue-time fallback', () => {
		// Producer-time projection invariant: each event's `at` (or
		// nested timestamp field for `endpoint.registered` /
		// `error.reported` / `build.statusChanged`) drives the rendered
		// `time`. Removing the historical `Date.now()` fallback prevents
		// late-flushed events from being back-dated to dequeue time,
		// which would surface as out-of-order log lines under load.
		const earlier = Date.parse('2026-05-19T20:11:00.000Z');
		const later = Date.parse('2026-05-19T20:11:32.001Z');
		const a = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('walrus'),
				line: 'first',
				level: 'warn',
				at: earlier,
			},
			0,
		);
		const b = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('walrus'),
				line: 'second',
				level: 'warn',
				at: later,
			},
			1,
		);
		expect(a?.time).toBe('20:11:00');
		expect(b?.time).toBe('20:11:32');
		// The id encodes the producer `at` — feeds the renderer's React key.
		expect(a?.id.startsWith(String(earlier))).toBe(true);
		expect(b?.id.startsWith(String(later))).toBe(true);
	});
});
