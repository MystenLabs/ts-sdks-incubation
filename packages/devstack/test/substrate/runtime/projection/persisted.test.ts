import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import type { SubscribableState } from '../../../../src/substrate/projection.ts';
import {
	readProjectionSnapshot,
	projectionSnapshotPath,
	writeProjectionSnapshot,
} from '../../../../src/substrate/runtime/projection/index.ts';

const roots: Array<string> = [];

const makeState = (): SubscribableState => ({
	identity: { app: 'app', stack: 'main', network: 'sui:local' },
	cycle: { id: 1, startedAt: 123, phase: 'running' },
	rows: [
		{
			key: 'test:row#0' as never,
			role: 'service',
			status: 'failed',
			phase: null,
			lastError: {
				at: 124,
				pluginKey: 'test:row#0' as never,
				tag: 'DemoError',
				summary: 'demo failed',
				chain: ['DemoError: demo failed'],
				severity: 'error',
			},
			logTail: { lines: ['hello'], level: 'error', truncated: false },
			endpoints: [],
			selectiveRestartHighlight: false,
			section: 'service',
			endpointSection: 'service',
		},
	],
	endpoints: [],
	accounts: [
		{
			key: 'account/alice',
			rowKey: 'account/alice#1' as never,
			name: 'alice',
			address: '0xabc',
			scheme: 'ed25519',
			source: 'real',
			funding: { status: 'unknown', balanceMist: null, requestedMist: null },
			walletVisible: false,
			updatedAt: 125,
		},
	],
	packages: [
		{
			key: 'package/vault',
			rowKey: 'package/vault#2' as never,
			name: 'vault',
			kind: 'local',
			packageId: '0x123',
			upgradeCapId: null,
			mvrPlaceholder: '@local/vault',
			sourcePath: 'move/vault',
			updatedAt: 126,
		},
	],
	errors: [
		{
			at: 124,
			pluginKey: 'test:row#0' as never,
			tag: 'DemoError',
			summary: 'demo failed',
			chain: ['DemoError: demo failed'],
			severity: 'error',
		},
	],
	lastEvent: { seq: 3, at: 124 },
	stackBuild: [],
});

describe('projection persistence', () => {
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('round-trips a real projection snapshot for status readers', async () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-projection-'));
		roots.push(root);
		const state = makeState();

		await Effect.runPromise(writeProjectionSnapshot(root, state));

		const restored = readProjectionSnapshot(root);
		expect(restored).toEqual(state);
	});

	it('treats a missing or malformed persisted projection as absent', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-projection-'));
		roots.push(root);

		expect(readProjectionSnapshot(root)).toBeNull();
		writeFileSync(projectionSnapshotPath(root), '{"version":1,"state":{"bad":true}}');
		expect(readProjectionSnapshot(root)).toBeNull();
	});
});
