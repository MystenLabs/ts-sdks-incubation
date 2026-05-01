import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DevstackConfig } from '../core/types.js';
import { resolveTarget } from './target.js';

const empty: DevstackConfig = { app: 'test', plugins: [] };
const withRpc: DevstackConfig = {
	app: 'test',
	plugins: [],
	networks: {
		testnet: { rpcUrl: 'https://rpc.testnet' },
		mainnet: { rpcUrl: 'https://rpc.mainnet' },
	},
};

describe('resolveTarget', () => {
	let appDir: string;

	beforeEach(() => {
		appDir = mkdtempSync(join(tmpdir(), 'devstack-target-'));
	});
	afterEach(() => {
		rmSync(appDir, { recursive: true, force: true });
	});

	it('defaults to localnet + active stack when raw is undefined', () => {
		const t = resolveTarget({ config: empty, appDir });
		expect(t.network).toBe('localnet');
		expect(t.stack).toBe('main');
		expect(t.rpcUrl).toBe('');
	});

	it('honors fallbackStack flag for localnet', () => {
		const t = resolveTarget({ config: empty, appDir, fallbackStack: 'scratch' });
		expect(t.stack).toBe('scratch');
	});

	it('reads active-stack pointer for localnet fallback', () => {
		mkdirSync(join(appDir, '.devstack'), { recursive: true });
		writeFileSync(join(appDir, '.devstack', 'active'), 'feature\n');
		const t = resolveTarget({ config: empty, appDir });
		expect(t.stack).toBe('feature');
	});

	it('parses bare network "testnet"', () => {
		const t = resolveTarget({ config: withRpc, appDir, raw: 'testnet' });
		expect(t.network).toBe('testnet');
		expect(t.stack).toBe('main');
		expect(t.rpcUrl).toBe('https://rpc.testnet');
	});

	it('parses bare network "mainnet"', () => {
		const t = resolveTarget({ config: withRpc, appDir, raw: 'mainnet' });
		expect(t.network).toBe('mainnet');
		expect(t.rpcUrl).toBe('https://rpc.mainnet');
	});

	it('parses bare value as stack name (localnet implied)', () => {
		const t = resolveTarget({ config: empty, appDir, raw: 'feature-x' });
		expect(t.network).toBe('localnet');
		expect(t.stack).toBe('feature-x');
		expect(t.rpcUrl).toBe('');
	});

	it('parses <network>:<stack> form for localnet', () => {
		const t = resolveTarget({ config: empty, appDir, raw: 'localnet:scratch' });
		expect(t.network).toBe('localnet');
		expect(t.stack).toBe('scratch');
	});

	it('ignores stack on live-net <network>:<stack>', () => {
		const t = resolveTarget({ config: withRpc, appDir, raw: 'testnet:ignored' });
		expect(t.network).toBe('testnet');
		expect(t.stack).toBe('main');
	});

	it('throws on unknown network in <prefix>:<stack>', () => {
		expect(() => resolveTarget({ config: empty, appDir, raw: 'tetnet:main' })).toThrow(
			/unknown network/,
		);
	});

	it('throws when live-net rpcUrl is missing', () => {
		expect(() => resolveTarget({ config: empty, appDir, raw: 'testnet' })).toThrow(
			/networks\.testnet\.rpcUrl/,
		);
	});
});
