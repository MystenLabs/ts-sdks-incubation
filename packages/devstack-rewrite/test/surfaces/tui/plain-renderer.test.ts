// Plain-renderer line-shape tests.
//
// Verifies each EngineEvent variant maps to a single structured line
// with the expected key=value payload. Pure: we test the formatters,
// not the IO side.

import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import { formatEventLine, formatHeartbeat } from '../../../src/surfaces/tui/plain-renderer.ts';

const STATIC_AT = Date.parse('2026-05-19T20:11:32.001Z');

describe('plain-renderer formatters', () => {
	it('formats lifecycle.statusChanged', () => {
		const line = formatEventLine({
			tag: 'lifecycle.statusChanged',
			pluginKey: pluginKey('sui'),
			from: 'acquiring',
			to: 'ready',
			at: STATIC_AT,
		});
		expect(line).toContain('lifecycle.statusChanged');
		expect(line).toContain('key=sui');
		expect(line).toContain('from=acquiring');
		expect(line).toContain('to=ready');
		expect(line).toContain('2026-05-19T20:11:32.001Z');
		expect(line.startsWith('2026-05-19T20:11:32.001Z INFO')).toBe(true);
	});

	it('formats log.appended with WARN level promotion', () => {
		const line = formatEventLine({
			tag: 'log.appended',
			pluginKey: pluginKey('walrus'),
			line: 'unable to bind port 9000',
			level: 'warn',
			at: STATIC_AT,
		});
		expect(line).toContain('WARN');
		expect(line).toContain('log.appended');
		expect(line).toContain('key=walrus');
		expect(line).toContain('line="unable to bind port 9000"');
	});

	it('formats endpoint.registered using displayUrl when set', () => {
		const event: EngineEvent = {
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey('e1'),
				name: 'aggregator',
				url: 'http://localhost:9000',
				displayUrl: 'https://devstack.local/agg',
				wireProtocol: 'http',
				registeredAt: STATIC_AT,
			},
		};
		const line = formatEventLine(event);
		expect(line).toContain('endpoint.registered');
		expect(line).toContain('name=aggregator');
		expect(line).toContain('url=https://devstack.local/agg');
	});

	it('formats error.reported as ERROR level', () => {
		const line = formatEventLine({
			tag: 'error.reported',
			error: {
				at: STATIC_AT,
				pluginKey: pluginKey('seal'),
				tag: 'BootError',
				summary: 'docker exited 1',
				chain: ['stderr: private content failed', 'exit code: 1'],
				severity: 'error',
			},
		});
		expect(line.startsWith(`2026-05-19T20:11:32.001Z ERROR`)).toBe(true);
		expect(line).toContain('error.reported');
		expect(line).toContain('tag=BootError');
		expect(line).toContain('cause="stderr: private content failed | exit code: 1"');
	});

	it('formats restart.requested for stack-wide target', () => {
		const line = formatEventLine({
			tag: 'restart.requested',
			target: 'stack',
			at: STATIC_AT,
		});
		expect(line).toContain('target=stack');
	});

	it('formats restart.requested for selective-restart target', () => {
		const line = formatEventLine({
			tag: 'restart.requested',
			target: { pluginKey: pluginKey('sui') },
			at: STATIC_AT,
		});
		expect(line).toContain('target=sui');
	});

	it('emits one line per heartbeat invocation', () => {
		const out = formatHeartbeat(STATIC_AT, 'sui', 'pulling image', 'service');
		expect(out.split('\n').length).toBe(1);
		expect(out).toContain('heartbeat');
		expect(out).toContain('key=sui');
		expect(out).toContain('narration="pulling image"');
	});
});
