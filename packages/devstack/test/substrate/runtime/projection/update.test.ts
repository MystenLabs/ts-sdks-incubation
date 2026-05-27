import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../../src/substrate/brand.ts';
import type { SubscribableState } from '../../../../src/substrate/projection.ts';
import { applyEvent } from '../../../../src/substrate/runtime/projection/index.ts';

const makeState = (): SubscribableState => ({
	identity: { app: 'arena', stack: 'arena', network: 'sui:local' },
	cycle: { id: 0, startedAt: 0, phase: 'running' },
	rows: [
		{
			key: pluginKey('wallet#0'),
			role: 'service',
			status: 'ready',
			phase: null,
			lastError: null,
			logTail: { lines: [], level: 'info', truncated: false },
			endpoints: [endpointKey('wallet#0:wallet-app')],
			selectiveRestartHighlight: false,
		},
	],
	endpoints: [
		{
			endpointKey: endpointKey('wallet#0:wallet-app'),
			pluginKey: pluginKey('wallet#0'),
			name: 'wallet-app',
			url: 'http://127.0.0.1:39200',
			displayUrl: null,
			wireProtocol: 'http',
			registeredAt: 1,
		},
	],
	accounts: [],
	packages: [],
	errors: [],
	lastEvent: { seq: 0, at: 1 },
	stackBuild: [],
});

describe('projection endpoint history', () => {
	it('keeps released endpoints visible as last-known operator URLs', () => {
		const before = makeState();
		const after = applyEvent(before, {
			tag: 'endpoint.released',
			endpointKey: endpointKey('wallet#0:wallet-app'),
			at: 2,
		});

		expect(after.endpoints).toEqual(before.endpoints);
		expect(after.rows[0]?.endpoints).toEqual(before.rows[0]?.endpoints);
		expect(after.lastEvent.at).toBe(2);
	});

	it('projects projection.updated[package] into the package table slice', () => {
		const after = applyEvent(makeState(), {
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
				updatedAt: 3,
			},
			at: 3,
		});

		expect(after.packages).toEqual([
			{
				key: 'package/vault',
				rowKey: pluginKey('package/vault#1'),
				name: 'vault',
				kind: 'local',
				packageId: '0x123',
				upgradeCapId: null,
				mvrPlaceholder: '@local/vault',
				sourcePath: 'move/vault',
				updatedAt: 3,
			},
		]);
		expect(after.lastEvent.at).toBe(3);
	});

	it('attaches endpoints by exact pluginKey instead of endpointKey prefix', () => {
		const before: SubscribableState = {
			...makeState(),
			rows: [
				{
					key: pluginKey('service#1'),
					role: 'service',
					status: 'ready',
					phase: null,
					lastError: null,
					logTail: { lines: [], level: 'info', truncated: false },
					endpoints: [],
					selectiveRestartHighlight: false,
				},
				{
					key: pluginKey('service#10'),
					role: 'service',
					status: 'ready',
					phase: null,
					lastError: null,
					logTail: { lines: [], level: 'info', truncated: false },
					endpoints: [],
					selectiveRestartHighlight: false,
				},
			],
			endpoints: [],
		};

		const after = applyEvent(before, {
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey('service#10:http'),
				pluginKey: pluginKey('service#10'),
				name: 'http',
				url: 'http://service.localhost',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 4,
			},
		});

		expect(after.rows[0]?.endpoints).toEqual([]);
		expect(after.rows[1]?.endpoints).toEqual([endpointKey('service#10:http')]);
	});
});
