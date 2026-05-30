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
			section: 'service',
			endpointSection: 'service',
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

	it('drops projection.updated[account] with malformed payload and leaves state untouched', () => {
		const before = makeState();
		const after = applyEvent(before, {
			tag: 'projection.updated',
			kind: 'account',
			key: 'account/bogus',
			// Intentionally malformed: missing every required field of
			// AccountProjectionSchema. The reducer must structurally
			// reject this via per-kind Schema decode, skip the slice
			// update, and keep the surrounding projection intact (the
			// supervise stream must not crash on misbehaving plugins).
			payload: { wrong: 'shape' },
			at: 5,
		});

		expect(after.accounts).toEqual(before.accounts);
		expect(after.packages).toEqual(before.packages);
		expect(after.rows).toEqual(before.rows);
		// `lastEvent.at` still advances — the event was observed even
		// though the slice update was skipped.
		expect(after.lastEvent.at).toBe(5);
	});

	it('drops projection.updated[package] with malformed payload and leaves state untouched', () => {
		const before = makeState();
		const after = applyEvent(before, {
			tag: 'projection.updated',
			kind: 'package',
			key: 'package/bogus',
			// `packageId` is required `string` per PackageProjectionSchema; the
			// number `123` must structurally fail decode.
			payload: { packageId: 123 },
			at: 6,
		});

		expect(after.packages).toEqual(before.packages);
		expect(after.accounts).toEqual(before.accounts);
		expect(after.lastEvent.at).toBe(6);
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
					section: 'service',
					endpointSection: 'service',
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
					section: 'service',
					endpointSection: 'service',
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
