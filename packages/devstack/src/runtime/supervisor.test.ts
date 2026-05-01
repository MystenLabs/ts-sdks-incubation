import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Supervisor } from './supervisor.js';

describe('Supervisor', () => {
	let appDir: string;

	beforeEach(() => {
		appDir = mkdtempSync(join(tmpdir(), 'devstack-supervisor-'));
	});
	afterEach(() => {
		rmSync(appDir, { recursive: true, force: true });
	});

	it('throws when constructed with a live network', () => {
		expect(
			() =>
				new Supervisor({
					appName: 'test',
					appDir,
					plugins: [],
					network: 'testnet',
				}),
		).toThrow(/localnet-only/);
		expect(
			() =>
				new Supervisor({
					appName: 'test',
					appDir,
					plugins: [],
					network: 'mainnet',
				}),
		).toThrow(/localnet-only/);
	});

	it('constructs successfully with default localnet network', () => {
		const sup = new Supervisor({ appName: 'test', appDir, plugins: [] });
		expect(sup.network).toBe('localnet');
	});

	it('constructs successfully with explicit localnet', () => {
		const sup = new Supervisor({
			appName: 'test',
			appDir,
			plugins: [],
			network: 'localnet',
		});
		expect(sup.network).toBe('localnet');
	});
});
