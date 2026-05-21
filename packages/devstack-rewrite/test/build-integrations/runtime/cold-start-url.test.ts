// `coldStartUrl` — conventional-route fallback tests.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';

import {
	coldStartUrl,
	NoConventionalRouteError,
	tryColdStartUrl,
	readAppName,
	type ConventionalRoute,
} from '../../../src/build-integrations/runtime/index.ts';

const ENV_KEYS = ['DEVSTACK_STACK'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const routes = new Map<string, ConventionalRoute>([
	['sui-rpc', { service: 'sui-rpc', port: 5174, wireProtocol: 'http' }],
	['frontend.dev-server', { service: 'dev', port: 5175, wireProtocol: 'http' }],
]);

describe('coldStartUrl', () => {
	it('builds <service>.<app>.localhost for main stack', () => {
		const url = coldStartUrl('sui-rpc', { routes, app: 'demo' });
		expect(url).toBe('http://sui-rpc.demo.localhost:5174');
	});

	it('prefixes <stack>. for non-main stack', () => {
		const url = coldStartUrl('sui-rpc', { routes, stack: 'feature-x', app: 'demo' });
		expect(url).toBe('http://feature-x.sui-rpc.demo.localhost:5174');
	});

	it('honors DEVSTACK_STACK env when stack is not passed', () => {
		process.env.DEVSTACK_STACK = 'feat';
		const url = coldStartUrl('sui-rpc', { routes, app: 'demo' });
		expect(url).toBe('http://feat.sui-rpc.demo.localhost:5174');
	});

	it('throws NoConventionalRouteError for unknown endpoint', () => {
		try {
			coldStartUrl('unknown-endpoint', { routes, app: 'demo' });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(NoConventionalRouteError);
			expect((err as NoConventionalRouteError).endpoint).toBe('unknown-endpoint');
			expect((err as NoConventionalRouteError).supported).toContain('sui-rpc');
		}
	});

	it('tryColdStartUrl returns undefined on miss', () => {
		expect(tryColdStartUrl('absent', { routes, app: 'demo' })).toBeUndefined();
	});
});

describe('readAppName', () => {
	it('strips @scope/ prefix', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-app-'));
		writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@org/my-app' }));
		expect(readAppName(tmp)).toBe('my-app');
	});

	it('returns the raw name when unscoped', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-app-'));
		writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'plain' }));
		expect(readAppName(tmp)).toBe('plain');
	});

	it('returns undefined when package.json is missing', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-app-'));
		expect(readAppName(tmp)).toBeUndefined();
	});

	it('returns undefined when name field is missing', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-app-'));
		writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '1.0.0' }));
		expect(readAppName(tmp)).toBeUndefined();
	});
});
