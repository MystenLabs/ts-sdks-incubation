import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type PlaywrightTestConfig, defineConfig, devices } from '@playwright/test';

import { createPortAllocator } from '../runtime/port-allocator.js';

type PlaywrightWebServer = NonNullable<PlaywrightTestConfig['webServer']>;
type PlaywrightWebServerSingle =
	PlaywrightWebServer extends Array<infer U> ? U : PlaywrightWebServer;

/** Like `Partial<PlaywrightTestConfig>` but lets callers override individual
 *  `webServer` / `use` fields without having to redeclare the whole object —
 *  the defineConfig defaults shallow-merge into the rest. */
export type DevstackPlaywrightExtend = Omit<Partial<PlaywrightTestConfig>, 'webServer' | 'use'> & {
	webServer?: Partial<PlaywrightWebServerSingle>;
	use?: Partial<NonNullable<PlaywrightTestConfig['use']>>;
};

export interface DevstackPlaywrightOptions {
	/** Preferred Vite dev-server port (hint to the per-stack port
	 * allocator). When `manageStack` is true the allocator may choose a
	 * different port if a sibling stack of the same app has already
	 * claimed this one — the resolved port lands in `<stackDir>/
	 * ports.json` and is what Playwright actually polls. Without
	 * `manageStack`, used as-is. */
	port: number;
	/** Override the dev-server bring-up command. Default: `pnpm dev`. */
	command?: string;
	/** Override the test directory. Default: `./e2e`. */
	testDir?: string;
	/** Extend the default config with arbitrary Playwright options.
	 *  `webServer` and `use` accept partial shapes — they're shallow-
	 *  merged onto the resolved defaults so an app can override just
	 *  `webServer.timeout` (or just `use.headless`) without re-declaring
	 *  the URL/command (or baseURL) the allocator filled in. */
	extend?: DevstackPlaywrightExtend;
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
	 *
	 * Returns a `Promise<PlaywrightTestConfig>` because port allocation
	 * runs at config-eval time (so the port allocator can claim a free
	 * port before sibling stacks of the same app race for it). User
	 * configs `await` the call:
	 *
	 *   export default await defineDevstackPlaywrightConfig({...});
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
 *
 * Async because port allocation must happen at config-eval time when
 * `manageStack` is true — the allocator claims `<stackDir>/ports.json`
 * before globalSetup runs so the resulting `baseURL` matches what the
 * webServer's `pnpm dev` will bind. User configs `await` the call:
 *
 *   export default await defineDevstackPlaywrightConfig({...});
 */
export async function defineDevstackPlaywrightConfig(
	opts: DevstackPlaywrightOptions,
): Promise<PlaywrightTestConfig> {
	const { port: preferredPort, command = 'pnpm dev', testDir = './e2e', extend } = opts;

	let globalSetup: string | undefined;
	let globalTeardown: string | undefined;
	let resolvedPort = preferredPort;
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
		// Pre-allocate the frontend port through the per-stack allocator
		// so it sees sibling stacks' claims and picks a non-conflicting
		// port. The runtime allocator (called from within the supervisor
		// when `pnpm dev` runs) hits the same cache, so vite binds the
		// same port Playwright is polling.
		const appDir = dirname(configPath);
		const stack = process.env.DEVSTACK_STACK ?? 'test';
		const allocator = createPortAllocator({ appDir, stack });
		const [allocated] = await allocator.allocate({
			slot: 'frontend.dev-server',
			preferred: preferredPort,
		});
		if (allocated === undefined) {
			throw new Error('defineDevstackPlaywrightConfig: port allocator returned no ports');
		}
		resolvedPort = allocated;
	}

	const baseURL = `http://localhost:${resolvedPort}`;

	// Pull `use` and `webServer` out of `extend` so we can shallow-merge
	// them over the defaults — without this, `extend.webServer = {
	// timeout: 180_000 }` would clobber the resolved URL + command and
	// land Playwright on the user's preferred port even when the
	// allocator picked something else (the original cause of
	// `notes/friction.md:127`'s 5-min webServer timeouts).
	const { use: extendUse, webServer: extendWebServer, ...extendRest } = extend ?? {};

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
			...extendUse,
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
			...extendWebServer,
		},
		...extendRest,
	});
}
