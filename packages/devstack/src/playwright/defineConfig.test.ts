// `defineDevstackPlaywrightConfig` returns the resolved Playwright
// config; the tests below pin two pieces of merge behavior that an
// earlier shape silently broke (notes/friction.md:127):
//
//   1. `extend.webServer = { timeout: ... }` keeps the resolved
//      `url` + `command` defaults — without shallow-merge, an app
//      that just wanted to bump timeout would also clobber the
//      allocator-resolved URL and time out at 5 min.
//   2. `extend.use = { ... }` keeps the resolved `baseURL`.
//   3. Sibling-stack-holds-port: when the per-stack allocator picks
//      a non-preferred port (because another stack of the same app
//      claimed the preferred one), `baseURL` reflects the actually-
//      bound port and the webServer URL matches.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineDevstackPlaywrightConfig } from './defineConfig.js';

let appDir: string;

beforeEach(() => {
	appDir = mkdtempSync(resolve(tmpdir(), 'devstack-playwright-config-test-'));
	process.env.DEVSTACK_E2E_CONFIG_PATH = resolve(appDir, 'devstack.config.ts');
	process.env.DEVSTACK_STACK = 'test';
});

afterEach(() => {
	rmSync(appDir, { recursive: true, force: true });
	delete process.env.DEVSTACK_E2E_CONFIG_PATH;
	delete process.env.DEVSTACK_STACK;
});

describe('defineDevstackPlaywrightConfig — extend merge', () => {
	it('preserves resolved baseURL when extend.use is supplied', async () => {
		const config = await defineDevstackPlaywrightConfig({
			port: 5173,
			extend: {
				use: { headless: false },
			},
		});
		expect(config.use?.baseURL).toBe('http://localhost:5173');
		expect(config.use?.headless).toBe(false);
	});

	it('preserves resolved url + command when extend.webServer overrides timeout', async () => {
		const config = await defineDevstackPlaywrightConfig({
			port: 5173,
			extend: {
				webServer: { timeout: 180_000 },
			},
		});
		const ws = asSingle(config.webServer);
		expect(ws.url).toBe('http://localhost:5173');
		expect(ws.command).toBe('pnpm dev');
		expect(ws.timeout).toBe(180_000);
	});

	it('still spreads other extend keys at top level', async () => {
		const config = await defineDevstackPlaywrightConfig({
			port: 5173,
			extend: { workers: 2 },
		});
		expect(config.workers).toBe(2);
	});
});

describe('defineDevstackPlaywrightConfig — port allocator integration', () => {
	it('reflects the allocator-resolved port in baseURL on sibling-stack collision', async () => {
		// Pre-claim port 5173 for a sibling 'main' stack of the same app.
		// The allocator collectSiblingTaken pass should pick this up and
		// reject 5173 as the preferred port for the 'test' stack.
		const siblingDir = resolve(appDir, '.devstack/stacks/main');
		writeFileSync(
			ensureDir(resolve(siblingDir, 'ports.json')),
			JSON.stringify({ 'frontend.dev-server': 5173 }),
		);

		const config = await defineDevstackPlaywrightConfig({
			port: 5173,
			manageStack: true,
			configPath: resolve(appDir, 'devstack.config.ts'),
		});
		const ws = asSingle(config.webServer);
		// Allocator picked a different port; both baseURL + webServer.url
		// reflect it.
		expect(config.use?.baseURL).not.toBe('http://localhost:5173');
		expect(config.use?.baseURL).toMatch(/^http:\/\/localhost:\d+$/);
		expect(ws.url).toBe(config.use?.baseURL);
	});
});

function asSingle(ws: unknown): { command?: string; url?: string; timeout?: number } {
	// Playwright's WebServer config is `WebServerConfig | WebServerConfig[]`.
	// All the shapes we produce in defineDevstackPlaywrightConfig are the
	// single form.
	if (Array.isArray(ws)) throw new Error('expected single webServer config');
	return ws as { command?: string; url?: string; timeout?: number };
}

function ensureDir(filePath: string): string {
	mkdirSync(resolve(filePath, '..'), { recursive: true });
	return filePath;
}
