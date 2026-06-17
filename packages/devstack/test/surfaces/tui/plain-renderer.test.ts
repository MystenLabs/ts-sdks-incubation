// Plain-renderer line-shape tests.
//
// Verifies each EngineEvent variant maps to a single structured line
// with the expected key=value payload. Pure: we test the formatters,
// not the IO side.

import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import {
	formatEventLine,
	formatHeartbeat,
	keepInQuiet,
} from '../../../src/surfaces/tui/plain-renderer.ts';
import {
	accountCells,
	endpointLine,
	packageCells,
	statusLabel,
} from '../../../src/surfaces/tui/display-derivation.ts';

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
		expect(line).toContain('from=starting');
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
				pluginKey: pluginKey('demo#0'),
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
		expect(line).toContain('displayUrl=https://devstack.local/agg');
		expect(line).toContain('url=http://localhost:9000');
	});

	it('formats projection.updated[account] with copyable account facts', () => {
		const line = formatEventLine({
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
				funding: {
					status: 'funded',
					balanceMist: null,
					requestedMist: '1000000000',
					entries: [
						{
							coin: 'SUI',
							fullCoinType: '0x2::sui::SUI',
							amount: '1000000000',
							status: 'funded',
						},
					],
				},
				walletVisible: false,
				updatedAt: STATIC_AT,
			},
			at: STATIC_AT,
		});
		expect(line).toContain('projection.updated');
		expect(line).toContain('key=account/alice');
		expect(line).toContain('row=account/alice#1');
		expect(line).toContain('address=0xabc');
		expect(line).toContain('scheme=ed25519');
		expect(line).toContain('source=real');
		expect(line).toContain('funding=funded');
		expect(line).toContain('fundingEntries=SUI:1000000000:funded');
		expect(line).toContain('requestedMist=1000000000');
	});

	it('formats projection.updated[package] with copyable package facts', () => {
		const line = formatEventLine({
			tag: 'projection.updated',
			kind: 'package',
			key: 'package/vault',
			payload: {
				key: 'package/vault',
				rowKey: pluginKey('package/vault#1'),
				name: 'vault',
				kind: 'local',
				packageId: '0x123',
				upgradeCapId: null,
				mvrPlaceholder: '@local/vault',
				sourcePath: 'move/vault',
				updatedAt: STATIC_AT,
			},
			at: STATIC_AT,
		});
		expect(line).toContain('projection.updated');
		expect(line).toContain('key=package/vault');
		expect(line).toContain('row=package/vault#1');
		expect(line).toContain('kind=local');
		expect(line).toContain('packageId=0x123');
		expect(line).toContain('mvr=@local/vault');
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

	it('formats engine.orchestrator.dispatchFailed as a WARN line carrying the cause discriminator', () => {
		// Observability regression: a non-fatal routing/contribution sink
		// (e.g. `routable`) rejecting leaves the plugin `ready`, so this WARN
		// line is the operator's only signal that RPC/wallet routing is dead.
		// It must render above INFO and name the failing sink + cause `_tag`.
		const line = formatEventLine({
			tag: 'engine.orchestrator.dispatchFailed',
			pluginKey: pluginKey('sui'),
			kind: 'routable',
			message: "routing/contribution sink 'routable' failed",
			causeType: 'RouterBootFailed',
			at: STATIC_AT,
		});
		expect(line.startsWith('2026-05-19T20:11:32.001Z WARN')).toBe(true);
		expect(line).toContain('engine.orchestrator.dispatchFailed');
		expect(line).toContain('key=sui');
		expect(line).toContain('kind=routable');
		expect(line).toContain('causeType=RouterBootFailed');
		expect(line).toContain('summary="routing/contribution sink \'routable\' failed"');
	});

	it('omits causeType on dispatchFailed when the cause is untagged', () => {
		const line = formatEventLine({
			tag: 'engine.orchestrator.dispatchFailed',
			pluginKey: pluginKey('sui'),
			kind: 'routable',
			message: 'sink failed',
			at: STATIC_AT,
		});
		expect(line).toContain('WARN');
		expect(line).not.toContain('causeType=');
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

	it('formats shutdown.escalated with signal and exit code', () => {
		const line = formatEventLine({
			tag: 'shutdown.escalated',
			signal: 'SIGTERM',
			exitCode: 143,
			at: STATIC_AT,
		});
		expect(line).toContain('shutdown.escalated');
		expect(line).toContain('mode=hard-kill');
		expect(line).toContain('signal=SIGTERM');
		expect(line).toContain('exitCode=143');
	});

	it('keeps plain and TUI helpers aligned on shared operator facts', () => {
		expect(
			formatEventLine({
				tag: 'lifecycle.statusChanged',
				pluginKey: pluginKey('sui'),
				from: 'acquiring',
				to: 'ready',
				at: STATIC_AT,
			}),
		).toContain(`to=${statusLabel('ready')}`);

		const endpoint = {
			endpointKey: endpointKey('e1'),
			pluginKey: pluginKey('demo#0'),
			name: 'dev',
			url: 'http://127.0.0.1:5173',
			displayUrl: 'http://dev.app.localhost:5175',
			wireProtocol: 'http',
			registeredAt: STATIC_AT,
		} as const;
		const endpointPlain = formatEventLine({ tag: 'endpoint.registered', endpoint });
		expect(endpointLine(endpoint)).toContain('http://dev.app.localhost:5175');
		expect(endpointPlain).toContain('displayUrl=http://dev.app.localhost:5175');
		expect(endpointPlain).toContain('url=http://127.0.0.1:5173');

		const account = {
			key: 'account/alice',
			rowKey: pluginKey('account/alice#1'),
			name: 'alice',
			address: '0xabc',
			scheme: 'ed25519',
			source: 'real',
			funding: {
				status: 'funded',
				balanceMist: null,
				requestedMist: '1000000000',
				entries: [
					{
						coin: 'SUI',
						fullCoinType: '0x2::sui::SUI',
						amount: '1000000000',
						status: 'funded',
					},
				],
			},
			walletVisible: false,
			updatedAt: STATIC_AT,
		} as const;
		const accountPlain = formatEventLine({
			tag: 'projection.updated',
			kind: 'account',
			key: account.key,
			payload: account,
			at: STATIC_AT,
		});
		expect(accountPlain).toContain(`address=${accountCells(account).address}`);
		expect(accountPlain).toContain(`scheme=${accountCells(account).scheme}`);
		expect(accountPlain).toContain('fundingEntries=SUI:1000000000:funded');

		const pkg = {
			key: 'package/vault',
			rowKey: pluginKey('package/vault#1'),
			name: 'vault',
			kind: 'local',
			packageId: '0x123',
			upgradeCapId: null,
			mvrPlaceholder: '@local/vault',
			sourcePath: 'move/vault',
			updatedAt: STATIC_AT,
		} as const;
		const packagePlain = formatEventLine({
			tag: 'projection.updated',
			kind: 'package',
			key: pkg.key,
			payload: pkg,
			at: STATIC_AT,
		});
		expect(packagePlain).toContain(`packageId=${packageCells(pkg).packageId}`);
		expect(packagePlain).toContain(`kind=${packageCells(pkg).kind}`);
	});

	it('emits one line per heartbeat invocation', () => {
		const out = formatHeartbeat(STATIC_AT, 'sui', 'pulling image', 'service');
		expect(out.split('\n').length).toBe(1);
		expect(out).toContain('heartbeat');
		expect(out).toContain('key=sui');
		expect(out).toContain('narration="pulling image"');
	});
});

describe('keepInQuiet', () => {
	const at = STATIC_AT;

	it('keeps the readiness milestone but drops intermediate transitions', () => {
		const sui = pluginKey('sui');
		expect(
			keepInQuiet({
				tag: 'lifecycle.statusChanged',
				pluginKey: sui,
				from: 'acquiring',
				to: 'ready',
				at,
			}),
		).toBe(true);
		expect(
			keepInQuiet({
				tag: 'lifecycle.statusChanged',
				pluginKey: sui,
				from: 'pending',
				to: 'acquiring',
				at,
			}),
		).toBe(false);
		// Teardown chatter (`from=ready to=stopping`) is exactly the noise we drop.
		expect(
			keepInQuiet({
				tag: 'lifecycle.statusChanged',
				pluginKey: sui,
				from: 'ready',
				to: 'stopping',
				at,
			}),
		).toBe(false);
	});

	it('always keeps warnings/errors, drops routine info log lines', () => {
		const walrus = pluginKey('walrus');
		expect(
			keepInQuiet({ tag: 'log.appended', pluginKey: walrus, level: 'error', line: 'boom', at }),
		).toBe(true);
		expect(
			keepInQuiet({ tag: 'log.appended', pluginKey: walrus, level: 'warn', line: 'careful', at }),
		).toBe(true);
		expect(
			keepInQuiet({ tag: 'log.appended', pluginKey: walrus, level: 'info', line: 'tick', at }),
		).toBe(false);
	});
});
