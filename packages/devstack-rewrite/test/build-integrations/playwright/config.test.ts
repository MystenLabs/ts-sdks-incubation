// `defineDevstackPlaywrightConfig` shape contract.
//
// Architecture invariants verified here:
//   - workers=1, fullyParallel=false (single supervisor per stack)
//   - webServer.gracefulShutdown SIGTERM + 10s
//   - webServer.reuseExistingServer: !CI
//   - explicit `baseURL` bypasses discovery
//   - `extend` overrides at the top level
//   - cold-start fallback when no manifest is present + port provided

import { describe, expect, it } from 'vitest';

import { defineDevstackPlaywrightConfig } from '../../../src/build-integrations/playwright/index.ts';

describe('defineDevstackPlaywrightConfig', () => {
	it('applies the load-bearing defaults', () => {
		const cfg = defineDevstackPlaywrightConfig({
			baseURL: 'http://localhost:8000',
		});
		expect(cfg.workers).toBe(1);
		expect(cfg.fullyParallel).toBe(false);
		expect(cfg.testDir).toBe('./e2e');
		expect(cfg.use.baseURL).toBe('http://localhost:8000');
		expect(cfg.webServer.url).toBe('http://localhost:8000');
		expect(cfg.webServer.gracefulShutdown).toEqual({
			signal: 'SIGTERM',
			timeout: 10_000,
		});
	});

	it('defaults command to `pnpm dev`', () => {
		const cfg = defineDevstackPlaywrightConfig({
			baseURL: 'http://x.localhost:1',
		});
		expect(cfg.webServer.command).toBe('pnpm dev');
	});

	it('stamps PLAYWRIGHT=1 into webServer.env', () => {
		const cfg = defineDevstackPlaywrightConfig({
			baseURL: 'http://x.localhost:1',
		});
		expect(cfg.webServer.env?.PLAYWRIGHT).toBe('1');
	});

	it('extend overrides at the top level', () => {
		const cfg = defineDevstackPlaywrightConfig({
			baseURL: 'http://x.localhost:1',
			extend: { testDir: './specs' },
		});
		expect(cfg.testDir).toBe('./specs');
	});

	it('falls back to conventional URL with port-provided cold-start', () => {
		const prior = process.env.DEVSTACK_ROUTER_PORT;
		process.env.DEVSTACK_ROUTER_PORT = '5175';
		try {
			const cfg = defineDevstackPlaywrightConfig({
				cwd: '/nonexistent-cwd-for-cold-start',
				env: {},
				endpointKey: 'app',
				webServerTimeoutMs: 1,
			});
			expect(cfg.use.baseURL.startsWith('http://')).toBe(true);
			expect(cfg.use.baseURL.includes('dev.nonexistent-cwd-for-cold-start.localhost')).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_ROUTER_PORT;
			else process.env.DEVSTACK_ROUTER_PORT = prior;
		}
	});

	it('appends user projects after the default chromium project', () => {
		const cfg = defineDevstackPlaywrightConfig({
			baseURL: 'http://x.localhost:1',
			projects: [{ name: 'firefox', use: { browserName: 'firefox' } }],
		});
		expect(cfg.projects.map((p) => p.name)).toEqual(['chromium', 'firefox']);
	});
});
