import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineDevstackPlaywrightConfig } from './define-config.js';

// The default factory body calls `baseURL`/`webServer` which read the
// manifest. With no manifest and no `DEVSTACK_STACK` set, both helpers
// fall back to the conventional URL for the named endpoint — perfect
// for a config-shape unit test that doesn't bring up a stack.
describe('defineDevstackPlaywrightConfig', () => {
	const priorEnv: { stack: string | undefined; manifestPath: string | undefined } = {
		stack: undefined,
		manifestPath: undefined,
	};

	beforeEach(() => {
		priorEnv.stack = process.env.DEVSTACK_STACK;
		priorEnv.manifestPath = process.env.DEVSTACK_MANIFEST_PATH;
		delete process.env.DEVSTACK_STACK;
		// Steer manifest discovery somewhere that has no manifest, so
		// the helpers fall back to the conventional URL path.
		process.env.DEVSTACK_MANIFEST_PATH = '/tmp/devstack-preset-test-nonexistent/manifest.json';
	});

	afterEach(() => {
		if (priorEnv.stack === undefined) delete process.env.DEVSTACK_STACK;
		else process.env.DEVSTACK_STACK = priorEnv.stack;
		if (priorEnv.manifestPath === undefined) delete process.env.DEVSTACK_MANIFEST_PATH;
		else process.env.DEVSTACK_MANIFEST_PATH = priorEnv.manifestPath;
	});

	it('emits the canonical playwright config at minimum invocation', () => {
		const config = defineDevstackPlaywrightConfig();
		expect(config.testDir).toBe('./e2e');
		expect(config.fullyParallel).toBe(false);
		expect(config.workers).toBe(1);
		expect(config.use?.trace).toBe('on-first-retry');
		expect(config.use?.screenshot).toBe('only-on-failure');
		expect(Array.isArray(config.projects)).toBe(true);
		expect(config.projects?.[0]?.name).toBe('chromium');
	});

	it('defaults webServer timeout to 300s', () => {
		const config = defineDevstackPlaywrightConfig();
		const ws = config.webServer as { timeout: number };
		expect(ws.timeout).toBe(300_000);
	});

	it('honors the timeout option (e.g. for walrus cold-start)', () => {
		const config = defineDevstackPlaywrightConfig({ timeout: 900_000 });
		const ws = config.webServer as { timeout: number };
		expect(ws.timeout).toBe(900_000);
	});

	it('passes through use overrides via extend.use', () => {
		const config = defineDevstackPlaywrightConfig({
			extend: { use: { trace: 'retain-on-failure' } },
		});
		expect(config.use?.trace).toBe('retain-on-failure');
		// Preset defaults still present where not overridden.
		expect(config.use?.screenshot).toBe('only-on-failure');
	});
});
