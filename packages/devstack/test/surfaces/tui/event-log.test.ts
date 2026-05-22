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
					chain: [],
					severity: 'error',
				},
			},
			1,
		);
		expect(error?.level).toBe('error');
		expect(error?.scope).toBe('Seal');
		expect(error?.scopeColor).toBe('cyan');
		expect(error?.message).toContain('private content key server exited');
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

	it('suppresses account updates because account state is table state', () => {
		expect(
			eventLogLineFromEvent(
				{
					tag: 'account.updated',
					account: {
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
});
