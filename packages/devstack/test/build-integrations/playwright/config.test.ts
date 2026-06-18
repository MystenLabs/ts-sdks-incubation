// Playwright config helper shape contract.
//
// Architecture invariants verified here:
//   - workers=1, fullyParallel=false (single supervisor per stack)
//   - explicit `baseURL` bypasses discovery
//   - cold-start fallback when no manifest is present + port provided
//
// The stack lifecycle is owned by the programmatic `globalSetup`
// (`global-setup.ts`), NOT a Playwright `webServer` — so there is no
// webServer shape to assert here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
} from '../../../src/build-integrations/playwright/index.ts';
import { CURRENT_MANIFEST_VERSION } from '../../../src/substrate/runtime/manifest/manifest.ts';

describe('playwright config helpers', () => {
	it('applies the load-bearing defaults', () => {
		const base = devstackPlaywrightBaseConfig();
		const use = devstackPlaywrightUse({
			baseURL: 'http://localhost:8000',
		});
		expect(base.workers).toBe(1);
		expect(base.fullyParallel).toBe(false);
		expect(base.testDir).toBe('./tests/browser');
		expect(base.globalSetup).toBe('@mysten-incubation/devstack/playwright/global-setup');
		expect(use.baseURL).toBe('http://localhost:8000');
	});

	it('falls back to conventional URL with port-provided cold-start', () => {
		const prior = process.env.DEVSTACK_ROUTER_PORT;
		process.env.DEVSTACK_ROUTER_PORT = '5175';
		try {
			const use = devstackPlaywrightUse({
				cwd: '/nonexistent-cwd-for-cold-start',
				env: {},
				endpointName: 'dev',
			});
			expect(use.baseURL.startsWith('http://')).toBe(true);
			expect(use.baseURL.includes('dev.nonexistent-cwd-for-cold-start.localhost')).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_ROUTER_PORT;
			else process.env.DEVSTACK_ROUTER_PORT = prior;
		}
	});

	it('falls back to the conventional dev-server URL without a manifest or env port', () => {
		const prior = process.env.DEVSTACK_ROUTER_PORT;
		delete process.env.DEVSTACK_ROUTER_PORT;
		try {
			const use = devstackPlaywrightUse({
				cwd: '/nonexistent-cwd-for-default-cold-start',
				env: {},
			});
			expect(use.baseURL).toBe('http://dev.nonexistent-cwd-for-default-cold-start.localhost:5175');
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_ROUTER_PORT;
			else process.env.DEVSTACK_ROUTER_PORT = prior;
		}
	});

	it('resolves the default app endpoint by endpoint name from a raw manifest key', () => {
		const workdir = mkdtempSync(join(tmpdir(), 'pw-config-ctx-'));
		try {
			const stateDir = join(workdir, '.devstack', 'stacks', 'main');
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				join(stateDir, 'manifest.json'),
				JSON.stringify({
					identity: { app: 'sample-app', stack: 'main', network: 'localnet' },
					manifestVersion: CURRENT_MANIFEST_VERSION,
					services: {},
					endpoints: {
						'host-service/app#5:dev': {
							name: 'dev',
							url: 'http://dev.sample-app.localhost:5175',
							displayUrl: 'http://dev.sample-app.localhost:5175',
							wireProtocol: 'http',
							pluginKey: 'host-service/app#5',
							endpointKey: 'host-service/app#5:dev',
						},
					},
					extras: {},
				}),
			);

			const use = devstackPlaywrightUse({ cwd: workdir, env: {} });
			expect(use.baseURL).toBe('http://dev.sample-app.localhost:5175');
		} finally {
			rmSync(workdir, { recursive: true, force: true });
		}
	});

	it('appends user projects after the default chromium project', () => {
		const projects = devstackPlaywrightProjects({
			projects: [{ name: 'firefox', use: { browserName: 'firefox' } }],
		});
		expect(projects.map((p) => p.name)).toEqual(['chromium', 'firefox']);
	});
});
