import type { PlaywrightTestConfig } from '@playwright/test';
import { devices } from '@playwright/test';
import { EndpointName } from '../runtime/endpoint-names.js';
import { baseURL, webServer, type WebServerOptions } from './web-server.js';

export interface DevstackPlaywrightConfigOptions {
	/** Manifest endpoint name to wire as both `webServer.url` and
	 *  `use.baseURL`. Default `'frontend.dev-server'` (matches the
	 *  endpoint name `Dev()` publishes). Must match the endpoint name
	 *  your `Dev(...)` primitive registers (or a conventional short
	 *  name like `'wallet-app'`). */
	readonly endpoint?: string;
	/** webServer startup timeout in ms. Default `300_000` (300s) covers
	 *  sui-localnet bring-up + publish + vite spawn. Bump to ~`900_000`
	 *  for apps with walrus/seal cold-start (first-image pull). */
	readonly timeout?: number;
	/** Extra `webServer` options forwarded to the underlying builder —
	 *  `command`, `manifestPath`, `extend`. */
	readonly webServer?: Omit<WebServerOptions, 'endpoint' | 'timeout'>;
	/** Extra fields merged shallowly into the resulting Playwright
	 *  config. Top-level keys win; `use` and `projects` are passed
	 *  through unchanged when present so callers can fully customize
	 *  them. */
	readonly extend?: PlaywrightTestConfig;
}

/**
 * Build the canonical devstack Playwright config. Apps reduce their
 * `playwright.config.ts` to a single call:
 *
 *   import { defineDevstackPlaywrightConfig }
 *     from '@mysten-incubation/devstack/playwright';
 *
 *   export default defineDevstackPlaywrightConfig({ timeout: 900_000 });
 *
 * Bundles: `testDir: './e2e'`, single-worker / no-parallel execution
 * (devstack apps share one supervisor per stack — parallel tests would
 * contend), CI-aware `forbidOnly` / `retries` / `reporter`, chromium
 * project, and `webServer` + `use.baseURL` wired from the manifest's
 * named endpoint.
 */
export function defineDevstackPlaywrightConfig(
	options: DevstackPlaywrightConfigOptions = {},
): PlaywrightTestConfig {
	const endpoint = options.endpoint ?? EndpointName.DEV_SERVER_PRIMARY;
	const timeout = options.timeout ?? 300_000;
	const extend = options.extend ?? {};

	const config: PlaywrightTestConfig = {
		testDir: './e2e',
		fullyParallel: false,
		workers: 1,
		forbidOnly: !!process.env.CI,
		retries: process.env.CI ? 2 : 0,
		reporter: process.env.CI ? [['github'], ['list']] : 'list',
		webServer: webServer({ endpoint, timeout, ...options.webServer }),
		use: {
			baseURL: baseURL({ endpoint, manifestPath: options.webServer?.manifestPath }),
			trace: 'on-first-retry',
			screenshot: 'only-on-failure',
			...extend.use,
		},
		projects: extend.projects ?? [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
		...stripHandledKeys(extend),
	};
	return config;
}

function stripHandledKeys(extend: PlaywrightTestConfig): Omit<PlaywrightTestConfig, HandledKey> {
	const { use: _u, projects: _p, ...rest } = extend;
	return rest;
}

type HandledKey = 'use' | 'projects';
