import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type PlaywrightTestConfig, defineConfig, devices } from '@playwright/test';

export interface DevstackPlaywrightOptions {
	/** Vite dev-server port. */
	port: number;
	/** Override the dev-server bring-up command. Default: `pnpm dev`. */
	command?: string;
	/** Override the test directory. Default: `./e2e`. */
	testDir?: string;
	/** Extend the default config with arbitrary Playwright options. */
	extend?: Partial<PlaywrightTestConfig>;
	/**
	 * When set, wires Playwright's globalSetup + globalTeardown to bring
	 * the localnet stack up before tests and tear it down after. Use this
	 * to keep `pnpm test:e2e` hermetic — no need for a separate
	 * `:setup` / `:teardown` script pair.
	 *
	 *   defineDevstackPlaywrightConfig({ port: 5176, manageStack: true })
	 *
	 * Stack name resolves from `DEVSTACK_STACK` env var (defaults to
	 * `'test'`). Teardown defaults to `'down'` (preserve volumes for
	 * resumability); set `DEVSTACK_E2E_TEARDOWN=drop` to wipe everything
	 * at the end (CI mode).
	 */
	manageStack?: boolean;
	/**
	 * Path to the devstack config to bring up. When `manageStack` is
	 * true, defaults to `./devstack.config.ts` resolved against the
	 * playwright config's directory.
	 */
	configPath?: string;
}

/**
 * Single-line Playwright config for dev-examples apps. Bakes in the same
 * defaults the four apps were duplicating: serial workers, GitHub-style CI
 * reporter, retries, screenshot-on-failure, Chromium project, and the
 * `pnpm dev` webServer.
 */
export function defineDevstackPlaywrightConfig(
	opts: DevstackPlaywrightOptions,
): PlaywrightTestConfig {
	const { port, command = 'pnpm dev', testDir = './e2e', extend } = opts;
	const baseURL = `http://localhost:${port}`;

	let globalSetup: string | undefined;
	let globalTeardown: string | undefined;
	if (opts.manageStack === true) {
		const here = dirname(fileURLToPath(import.meta.url));
		// Match the extension to the consuming environment: workspace dev
		// (running from `src/`) ships `.ts`; published `dist/` ships `.mjs`.
		// Playwright loads global-setup/teardown via Node's require, which
		// can't transform `.ts` itself — but workspace devs run via tsx,
		// which patches Node's loader to handle `.ts`.
		const isSrc = here.includes(`${'/'}src${'/'}playwright`);
		const ext = isSrc ? 'ts' : 'mjs';
		globalSetup = resolve(here, `global-setup.${ext}`);
		globalTeardown = resolve(here, `global-teardown.${ext}`);
		// Resolve the config path from the calling project's cwd; persist
		// via env var so the global-setup/teardown modules pick it up
		// without needing import-time access to `opts`.
		const configPath = resolve(opts.configPath ?? './devstack.config.ts');
		process.env.DEVSTACK_E2E_CONFIG_PATH = configPath;
	}

	return defineConfig({
		testDir,
		fullyParallel: false,
		workers: 1,
		forbidOnly: !!process.env.CI,
		retries: process.env.CI ? 2 : 0,
		reporter: process.env.CI ? [['github'], ['list']] : 'list',
		globalSetup,
		globalTeardown,
		// Bump the dev-server timeout when managing the stack — first
		// bring-up of walrus/seal images on a cold cache takes ~75s; the
		// `pnpm dev` Vite server itself is fast but waits on the manifest
		// the stack writes.
		timeout: opts.manageStack === true ? 120_000 : undefined,
		use: {
			baseURL,
			trace: 'on-first-retry',
			screenshot: 'only-on-failure',
		},
		projects: [
			{
				name: 'chromium',
				use: { ...devices['Desktop Chrome'] },
			},
		],
		webServer: {
			command,
			url: baseURL,
			reuseExistingServer: !process.env.CI,
			// Cold-cache builds (sui-localnet docker image, walrus+seal
			// images for private-content) can take several minutes the
			// first time. globalSetup with `manageStack: true` should
			// already have the stack up by the time this fires, but the
			// `pnpm dev` keepalive may still re-validate the stack —
			// give it room. 5 min covers cold sui; private-content
			// override with a higher value if walrus/seal images are
			// also cold.
			timeout: opts.manageStack === true ? 300_000 : 60_000,
		},
		...extend,
	});
}
