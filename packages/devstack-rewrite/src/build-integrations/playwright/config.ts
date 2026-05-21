// Playwright config builder.
//
// Architecture (distilled/23-build-integrations.md § Playwright /
// "What it produces"):
//
//   A canonical `PlaywrightTestConfig` (workers 1, fullyParallel
//   false, `testDir: './e2e'`, CI-aware reporter/retries/forbidOnly,
//   graceful-shutdown wiring with a SIGTERM + 10s timeout).
//   `webServer` + `baseURL` low-level resolvers.
//
// Load-bearing invariants this module enforces:
//   - `workers: 1` and `fullyParallel: false` — single supervisor per
//     stack; parallel tests would contend on shared faucet / wallet
//     / RPC (distilled § Invariants).
//   - `webServer.gracefulShutdown` SIGTERM + 10s — without this the
//     default SIGKILL-on-shell orphans vite + supervisor descendants
//     holding ports (distilled § Learnings: "Graceful-shutdown wiring
//     at the Playwright layer fixed a real bug").
//   - `webServer.url` settable at config-load time even with no
//     manifest — via cold-start fallback to a conventional URL.
//   - `webServer.reuseExistingServer: !CI` — dev iteration reuses,
//     CI always boots fresh.
//
// This module returns a `PlaywrightTestConfig`-shaped object. We do
// NOT import `@playwright/test` at module init: the type is
// structural and we accept the optional-peer cost rather than
// importing transitively from a build-integration that must be
// loadable without `@playwright/test` (matching the Vitest preset's
// optional-peer pattern).

import { type ResolveStackContextOptions, resolveEndpointUrl } from './stack-context.ts';

// -----------------------------------------------------------------------------
// PlaywrightTestConfig shape (structural; we do NOT import the type
// directly to keep `@playwright/test` an optional peer)
// -----------------------------------------------------------------------------

/** Subset of `PlaywrightTestConfig` this surface produces. The full
 *  type lives in `@playwright/test`; we keep this structural so the
 *  preset compiles without the peer. */
export interface PlaywrightTestConfigShape {
	readonly testDir: string;
	readonly fullyParallel: boolean;
	readonly forbidOnly: boolean;
	readonly retries: number;
	readonly workers: number;
	readonly reporter: ReadonlyArray<readonly [string, Record<string, unknown>?]> | string;
	readonly use: {
		readonly baseURL: string;
		readonly trace: 'on-first-retry' | 'off' | 'retain-on-failure';
		readonly screenshot: 'only-on-failure' | 'off' | 'on';
	} & Record<string, unknown>;
	readonly projects: ReadonlyArray<{
		readonly name: string;
		readonly use: Record<string, unknown>;
	}>;
	readonly webServer: {
		readonly command: string;
		readonly url: string;
		readonly reuseExistingServer: boolean;
		readonly timeout: number;
		readonly stdout: 'pipe' | 'ignore';
		readonly stderr: 'pipe' | 'ignore';
		readonly gracefulShutdown: { readonly signal: 'SIGTERM'; readonly timeout: number };
		readonly env?: Record<string, string>;
	};
	readonly globalSetup?: string;
	readonly globalTeardown?: string;
}

// -----------------------------------------------------------------------------
// Public option shape
// -----------------------------------------------------------------------------

/**
 * Options for `defineDevstackPlaywrightConfig`. Every field is
 * optional; defaults match the architecture invariants. Apps supply
 * only what they need to override.
 */
export interface DefineDevstackPlaywrightConfigOptions extends ResolveStackContextOptions {
	/** Test directory. Default: `'./e2e'` (architecture invariant). */
	readonly testDir?: string;

	/** Endpoint key whose URL becomes `webServer.url` + `use.baseURL`.
	 *  Default: `'app'` (the example app's vite dev server). */
	readonly endpointKey?: string;

	/** Explicit baseURL override. When set, manifest discovery is
	 *  bypassed entirely. */
	readonly baseURL?: string;

	/** Command Playwright runs to bring up the stack. Default:
	 *  `'pnpm dev'`. */
	readonly command?: string;

	/** Hard cap (ms) for `webServer` URL to become reachable. Default:
	 *  300_000 (5 min) — accounts for cold supervisor boot under
	 *  Docker pulls. */
	readonly webServerTimeoutMs?: number;

	/** Hard cap (ms) for `webServer.gracefulShutdown`. Default: 10_000
	 *  (10 s) — load-bearing per architecture § Invariants. */
	readonly gracefulShutdownTimeoutMs?: number;

	/** Extra env to forward to `webServer.command`. Merged after the
	 *  preset's own env (PLAYWRIGHT=1, DEVSTACK_STACK). */
	readonly env?: Record<string, string>;

	/** Extra Playwright projects to append to the default Chromium
	 *  project. */
	readonly projects?: ReadonlyArray<{
		readonly name: string;
		readonly use: Record<string, unknown>;
	}>;

	/** Path to a global-setup module. Defaults to the preset's bundled
	 *  global-setup (verifies the stack is reachable and populates
	 *  fixtures). Pass `null` to opt out. */
	readonly globalSetup?: string | null;

	/** `extend` — top-level keys win. Final escape hatch when the app
	 *  needs an option this preset doesn't expose. */
	readonly extend?: Partial<PlaywrightTestConfigShape>;
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_TEST_DIR = './e2e';
const DEFAULT_COMMAND = 'pnpm dev';
const DEFAULT_WEBSERVER_TIMEOUT_MS = 300_000;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 10_000;
const DEFAULT_ENDPOINT_KEY = 'app';

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

/**
 * Construct the canonical Playwright config. This is a pure function;
 * the only side effect is the synchronous manifest read (delegated to
 * `resolveEndpointUrl` from `stack-context.ts`).
 *
 * Caller passes options; we apply defaults + the architecture
 * invariants; user `extend` block overrides at the top level.
 */
export const buildPlaywrightConfig = (
	options: DefineDevstackPlaywrightConfigOptions = {},
): PlaywrightTestConfigShape => {
	const env = options.env ? { ...options.env } : {};
	const ci = Boolean(process.env.CI);

	const endpointKey = options.endpointKey ?? DEFAULT_ENDPOINT_KEY;
	const baseURL =
		options.baseURL ??
		resolveEndpointUrl(endpointKey, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.manifestPath !== undefined ? { manifestPath: options.manifestPath } : {}),
			...(options.stack !== undefined ? { stack: options.stack } : {}),
			...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
			...(options.env !== undefined
				? { env: options.env as Readonly<Record<string, string | undefined>> }
				: {}),
		}).url;

	const presetEnv: Record<string, string> = {
		PLAYWRIGHT: '1',
		...(options.stack !== undefined ? { DEVSTACK_STACK: options.stack } : {}),
		...env,
	};

	const baseConfig: PlaywrightTestConfigShape = {
		testDir: options.testDir ?? DEFAULT_TEST_DIR,
		fullyParallel: false,
		forbidOnly: ci,
		retries: ci ? 2 : 0,
		workers: 1,
		reporter: ci ? [['github'], ['list']] : 'list',
		use: {
			baseURL,
			trace: 'on-first-retry',
			screenshot: 'only-on-failure',
		},
		projects: [
			{
				name: 'chromium',
				use: { browserName: 'chromium' },
			},
			...(options.projects ?? []),
		],
		webServer: {
			command: options.command ?? DEFAULT_COMMAND,
			url: baseURL,
			reuseExistingServer: !ci,
			timeout: options.webServerTimeoutMs ?? DEFAULT_WEBSERVER_TIMEOUT_MS,
			stdout: 'pipe',
			stderr: 'pipe',
			gracefulShutdown: {
				signal: 'SIGTERM',
				timeout: options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS,
			},
			env: presetEnv,
		},
		globalSetup: options.globalSetup === null ? undefined : (options.globalSetup ?? undefined),
	};

	// `extend` overrides at the top level — user wins.
	if (options.extend !== undefined) {
		return { ...baseConfig, ...options.extend } as PlaywrightTestConfigShape;
	}
	return baseConfig;
};
