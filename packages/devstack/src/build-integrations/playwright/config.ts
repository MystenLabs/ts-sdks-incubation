// Playwright config helpers.
//
// Architecture (distilled/23-build-integrations.md § Playwright /
// "What it produces"):
//
//   Composable pieces for a canonical `PlaywrightTestConfig`
//   (workers 1, fullyParallel false, `testDir: './e2e'`,
//   CI-aware reporter/retries/forbidOnly, graceful-shutdown wiring
//   with a SIGTERM + 10s timeout), plus `webServer` + `baseURL`
//   low-level resolvers.
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
// This module returns `PlaywrightTestConfig`-shaped fragments. We do
// NOT import `@playwright/test` at module init: the types are
// structural and we accept the optional-peer cost rather than
// importing transitively from a build-integration that must be
// loadable without `@playwright/test` (matching the Vitest helpers'
// optional-peer pattern).

import { type ResolveStackContextOptions, resolveEndpointUrl } from './stack-context.ts';

// -----------------------------------------------------------------------------
// PlaywrightTestConfig shape (structural; we do NOT import the type
// directly to keep `@playwright/test` an optional peer)
// -----------------------------------------------------------------------------

type PlaywrightReporterShape = [string] | [string, Record<string, unknown>];
type PlaywrightGlobalSetupShape = string | ReadonlyArray<string>;

const DEFAULT_GLOBAL_SETUP = '@mysten-incubation/devstack/playwright/global-setup';

/** Base subset of `PlaywrightTestConfig` this surface produces. The
 *  full type lives in `@playwright/test`; we keep this structural so
 *  the helpers compile without the peer. */
export interface PlaywrightBaseConfigShape {
	readonly testDir: string;
	readonly fullyParallel: boolean;
	readonly forbidOnly: boolean;
	readonly retries: number;
	readonly workers: number;
	readonly reporter: PlaywrightReporterShape[] | string;
	readonly globalSetup?: PlaywrightGlobalSetupShape;
	readonly globalTeardown?: string;
}

export type PlaywrightUseConfigShape = {
	readonly baseURL: string;
	readonly trace: 'on-first-retry' | 'off' | 'retain-on-failure';
	readonly screenshot: 'only-on-failure' | 'off' | 'on';
} & Record<string, unknown>;

export interface PlaywrightProjectShape {
	name: string;
	use: Record<string, unknown>;
}

export interface PlaywrightWebServerConfigShape {
	readonly command: string;
	readonly url: string;
	readonly reuseExistingServer: boolean;
	readonly timeout: number;
	readonly stdout: 'pipe' | 'ignore';
	readonly stderr: 'pipe' | 'ignore';
	readonly gracefulShutdown: { readonly signal: 'SIGTERM'; readonly timeout: number };
	readonly env?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// Public option shape
// -----------------------------------------------------------------------------

export interface DevstackPlaywrightBaseConfigOptions {
	/** Test directory. Default: `'./e2e'` (architecture invariant). */
	readonly testDir?: string;

	/** Path to a global-setup module. Default: the devstack setup that
	 *  waits for post-acquire codegen before specs load the app. Pass
	 *  `null` to keep the property omitted when composing conditionally. */
	readonly globalSetup?: PlaywrightGlobalSetupShape | null;
}

export interface DevstackPlaywrightEndpointOptions extends ResolveStackContextOptions {
	/** Endpoint name whose URL becomes `webServer.url` + `use.baseURL`.
	 *  Default: `'dev'` (the host-service dev server endpoint). */
	readonly endpointName?: string;

	/** Explicit baseURL override. When set, manifest discovery is
	 *  bypassed entirely. */
	readonly baseURL?: string;
}

export interface DevstackPlaywrightWebServerOptions extends DevstackPlaywrightEndpointOptions {
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
}

export interface DevstackPlaywrightProjectsOptions {
	/** Extra Playwright projects to append to the default Chromium
	 *  project. */
	readonly projects?: ReadonlyArray<PlaywrightProjectShape>;
}

export interface DevstackPlaywrightUseOptions extends DevstackPlaywrightEndpointOptions {
	readonly trace?: PlaywrightUseConfigShape['trace'];
	readonly screenshot?: PlaywrightUseConfigShape['screenshot'];
	readonly use?: Omit<Partial<PlaywrightUseConfigShape>, 'baseURL'>;
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_TEST_DIR = './e2e';
const DEFAULT_COMMAND = 'pnpm dev';
const DEFAULT_WEBSERVER_TIMEOUT_MS = 300_000;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 10_000;
const DEFAULT_ENDPOINT_NAME = 'dev';

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

/**
 * Resolve the browser app URL Playwright should target. This is the
 * only helper here that may synchronously read the manifest; callers
 * can pass `baseURL` to bypass discovery entirely.
 */
export const resolveDevstackPlaywrightBaseURL = (
	options: DevstackPlaywrightEndpointOptions = {},
): string => {
	const endpointName = options.endpointName ?? DEFAULT_ENDPOINT_NAME;
	return (
		options.baseURL ??
		resolveEndpointUrl(endpointName, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.manifestPath !== undefined ? { manifestPath: options.manifestPath } : {}),
			...(options.stack !== undefined ? { stack: options.stack } : {}),
			...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
			...(options.env !== undefined ? { env: options.env } : {}),
		}).url
	);
};

export const devstackPlaywrightBaseConfig = (
	options: DevstackPlaywrightBaseConfigOptions = {},
): PlaywrightBaseConfigShape => {
	const ci = Boolean(process.env.CI);
	return {
		testDir: options.testDir ?? DEFAULT_TEST_DIR,
		fullyParallel: false,
		forbidOnly: ci,
		retries: ci ? 2 : 0,
		workers: 1,
		reporter: ci ? [['github'], ['list']] : 'list',
		globalSetup:
			options.globalSetup === null ? undefined : (options.globalSetup ?? DEFAULT_GLOBAL_SETUP),
	};
};

export const devstackPlaywrightUse = (
	options: DevstackPlaywrightUseOptions = {},
): PlaywrightUseConfigShape => ({
	baseURL: resolveDevstackPlaywrightBaseURL(options),
	trace: options.trace ?? 'on-first-retry',
	screenshot: options.screenshot ?? 'only-on-failure',
	...options.use,
});

export const devstackPlaywrightProjects = (
	options: DevstackPlaywrightProjectsOptions = {},
): PlaywrightProjectShape[] => [
	{
		name: 'chromium',
		use: { browserName: 'chromium' },
	},
	...(options.projects ?? []),
];

export const devstackPlaywrightWebServer = (
	options: DevstackPlaywrightWebServerOptions = {},
): PlaywrightWebServerConfigShape => {
	const env = options.env ? { ...options.env } : {};
	const ci = Boolean(process.env.CI);
	const baseURL = resolveDevstackPlaywrightBaseURL(options);
	const presetEnv: Record<string, string> = {
		PLAYWRIGHT: '1',
		...(options.stack !== undefined ? { DEVSTACK_STACK: options.stack } : {}),
		...env,
	};

	return {
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
	};
};
