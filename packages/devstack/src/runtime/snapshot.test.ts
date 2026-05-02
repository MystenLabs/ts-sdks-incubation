import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeSnapshotId, listSnapshots, snapshotIdFromConfig } from './snapshot.js';

describe('computeSnapshotId', () => {
	const baseInput = {
		appName: 'token-studio',
		stack: 'main',
		platform: 'darwin/arm64',
		suiImage: 'dev-examples/sui-localnet:devnet-v1.71.0-r7',
		accountNames: ['alice', 'bob', 'publisher'],
		plugins: [
			{ name: 'sui', version: '1.0.0', inputs: { rpcPort: 9000 } },
			{ name: 'walrus', version: '1.0.0', inputs: { rev: 'abc123' } },
		],
	} as const;

	it('returns the same id for identical inputs', () => {
		const a = computeSnapshotId(baseInput);
		const b = computeSnapshotId(baseInput);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]+$/);
	});

	it('produces a different id when any plugin input changes', () => {
		const a = computeSnapshotId(baseInput);
		const b = computeSnapshotId({
			...baseInput,
			plugins: [
				{ name: 'sui', version: '1.0.0', inputs: { rpcPort: 9001 } },
				{ name: 'walrus', version: '1.0.0', inputs: { rev: 'abc123' } },
			],
		});
		expect(a).not.toBe(b);
	});

	it('produces a different id when sui image changes', () => {
		const a = computeSnapshotId(baseInput);
		const b = computeSnapshotId({
			...baseInput,
			suiImage: 'dev-examples/sui-localnet:devnet-v1.72.0-r7',
		});
		expect(a).not.toBe(b);
	});

	it('produces a different id when platform changes', () => {
		const a = computeSnapshotId(baseInput);
		const b = computeSnapshotId({ ...baseInput, platform: 'linux/amd64' });
		expect(a).not.toBe(b);
	});

	it('is order-stable across plugin and account permutations', () => {
		const a = computeSnapshotId(baseInput);
		const b = computeSnapshotId({
			...baseInput,
			plugins: [...baseInput.plugins].reverse(),
			accountNames: [...baseInput.accountNames].reverse(),
		});
		expect(a).toBe(b);
	});
});

describe('snapshotIdFromConfig', () => {
	it('forwards platform from process.platform/process.arch', () => {
		const id = snapshotIdFromConfig({
			appName: 'app',
			stack: 'main',
			plugins: [{ name: 'sui', version: '1.0.0' }],
			accountNames: ['alice'],
		});
		expect(id).toMatch(/^[a-f0-9]+$/);
	});
});

describe('listSnapshots', () => {
	it('returns [] when the snapshots dir does not exist', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-snapshot-test-'));
		try {
			const result = await listSnapshots(dir);
			expect(result).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
