import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emit } from '../actions/emit.js';
import { register } from '../actions/register.js';
import { applyFilter, deployFilter, emitOnlyFilter } from '../cli/filters.js';
import { definePlugin } from '../plugin.js';
import { runOneShot } from './one-shot.js';

describe('runOneShot — actionFilter', () => {
	let appDir: string;

	beforeEach(() => {
		appDir = mkdtempSync(join(tmpdir(), 'devstack-oneshot-'));
	});
	afterEach(() => {
		rmSync(appDir, { recursive: true, force: true });
	});

	it('default deployFilter runs Build/Publish/Register/Emit on live nets', async () => {
		const reg = register({ name: 'r', inputs: {}, run: async () => {} });
		const em = emit({
			name: 'e',
			dependsOnKind: [],
			inputs: {},
			run: async () => {},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [reg, em] });

		const result = await runOneShot({
			appName: 'test',
			appDir,
			network: 'testnet',
			rpcUrl: 'https://t',
			plugins: [plugin],
		});

		expect(result.statuses.get('p.r')).toBe('healthy');
		expect(result.statuses.get('p.e')).toBe('healthy');
	});

	it('emitOnlyFilter drops non-Emit actions', async () => {
		let registerRan = false;
		let emitRan = false;
		const reg = register({
			name: 'r',
			inputs: {},
			run: async () => {
				registerRan = true;
			},
		});
		const em = emit({
			name: 'e',
			dependsOnKind: [],
			inputs: {},
			run: async () => {
				emitRan = true;
			},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [reg, em] });

		const result = await runOneShot({
			appName: 'test',
			appDir,
			network: 'testnet',
			rpcUrl: 'https://t',
			plugins: [plugin],
			actionFilter: emitOnlyFilter,
			readOnly: true,
		});

		expect(registerRan).toBe(false);
		expect(emitRan).toBe(true);
		expect(result.statuses.has('p.r')).toBe(false);
		expect(result.statuses.get('p.e')).toBe('healthy');
	});

	it('readOnly: true skips writing the manifest', async () => {
		const em = emit({
			name: 'e',
			dependsOnKind: [],
			inputs: {},
			run: async () => {},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [em] });

		const result = await runOneShot({
			appName: 'test',
			appDir,
			network: 'testnet',
			rpcUrl: 'https://t',
			plugins: [plugin],
			actionFilter: emitOnlyFilter,
			readOnly: true,
		});

		expect(existsSync(result.manifestPath)).toBe(false);
	});

	it('readOnly: false writes the manifest by default', async () => {
		const em = emit({
			name: 'e',
			dependsOnKind: [],
			inputs: {},
			run: async () => {},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [em] });

		const result = await runOneShot({
			appName: 'test',
			appDir,
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
			plugins: [plugin],
		});

		expect(existsSync(result.manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
			registry: { services?: Array<{ name: string; url: string }> };
		};
		const rpcService = manifest.registry.services?.find((s) => s.name === 'sui-rpc');
		expect(rpcService?.url).toBe('https://rpc.example');
	});

	it('skips sui-rpc pre-registration on localnet (sui plugin owns it)', async () => {
		const em = emit({
			name: 'e',
			dependsOnKind: [],
			inputs: {},
			run: async () => {},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [em] });

		const result = await runOneShot({
			appName: 'test',
			appDir,
			network: 'localnet',
			rpcUrl: 'http://127.0.0.1:9000',
			plugins: [plugin],
			actionFilter: applyFilter,
		});

		// Manifest written; no sui-rpc service since the sui plugin isn't
		// in the action graph and runOneShot only pre-registers on live nets.
		const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
			registry: { services?: Array<{ name: string; url: string }> };
		};
		expect(manifest.registry.services?.find((s) => s.name === 'sui-rpc')).toBeUndefined();
	});

	it('filters Seed actions by network gate (deployFilter)', async () => {
		const { seed } = await import('../actions/seed.js');
		let localnetSeedRan = false;
		let liveSeedRan = false;
		const localOnly = seed({
			name: 'local-only',
			inputs: {},
			run: async () => {
				localnetSeedRan = true;
			},
		});
		const allLive = seed({
			name: 'all-live',
			liveNetworks: true,
			inputs: {},
			run: async () => {
				liveSeedRan = true;
			},
		});
		const plugin = definePlugin({ name: 'p', actions: () => [localOnly, allLive] });

		await runOneShot({
			appName: 'test',
			appDir,
			network: 'testnet',
			rpcUrl: 'https://t',
			plugins: [plugin],
			actionFilter: deployFilter,
		});

		expect(localnetSeedRan).toBe(false);
		expect(liveSeedRan).toBe(true);
	});
});
