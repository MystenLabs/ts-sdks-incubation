import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import {
	appendEventLogLine,
	eventLogLineFromEvent,
	type EventLogLine,
	MAX_EVENT_LOG_LINES,
	shutdownRequestedLine,
} from '../../../src/surfaces/tui/event-log.ts';

const AT = Date.parse('2026-05-19T20:11:32.001Z');

describe('event log derivation', () => {
	it('renders log.appended as a global stream line', () => {
		const line = eventLogLineFromEvent(
			{
				tag: 'log.appended',
				pluginKey: pluginKey('walrus'),
				line: 'publisher ready',
				level: 'info',
				at: AT,
			},
			0,
		);
		expect(line).toMatchObject({
			level: 'info',
			text: '20:11:32 Walrus: publisher ready',
		});
	});

	it('renders failures and endpoints for the scrollback above the dashboard', () => {
		const error = eventLogLineFromEvent(
			{
				tag: 'error.reported',
				error: {
					at: AT,
					pluginKey: pluginKey('seal'),
					tag: 'BootError',
					summary: 'private content key server exited',
					chain: [],
					severity: 'error',
				},
			},
			1,
		);
		const endpoint = eventLogLineFromEvent(
			{
				tag: 'endpoint.registered',
				endpoint: {
					endpointKey: endpointKey('sui:rpc'),
					name: 'rpc',
					url: 'http://localhost:9000',
					displayUrl: null,
					wireProtocol: 'http',
					registeredAt: AT,
				},
			},
			2,
		);
		expect(error?.level).toBe('error');
		expect(error?.text).toContain('private content key server exited');
		expect(endpoint?.text).toContain('endpoint rpc: http://localhost:9000');
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
			text: '20:11:32 shutdown escalated by SIGINT (exit 130)',
		});
	});

	it('renders graceful shutdown as a static operator warning', () => {
		expect(shutdownRequestedLine(AT, 4)).toMatchObject({
			level: 'warn',
			text: '20:11:32 shutdown requested',
		});
	});

	it('keeps the event log bounded', () => {
		const lines = Array.from({ length: MAX_EVENT_LOG_LINES + 2 }, (_, idx) => ({
			id: String(idx),
			text: String(idx),
			level: 'info' as const,
		})).reduce<ReadonlyArray<EventLogLine>>((acc, line) => appendEventLogLine(acc, line), []);
		expect(lines).toHaveLength(MAX_EVENT_LOG_LINES);
		expect(lines[0]?.id).toBe('2');
	});
});
