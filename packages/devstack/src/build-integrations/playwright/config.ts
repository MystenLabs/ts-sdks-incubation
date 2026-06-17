// Playwright config helpers.
//
// Architecture (distilled/23-build-integrations.md § Playwright /
// "What it produces"):
//
//   Composable pieces for a canonical `PlaywrightTestConfig`
//   (workers 1, fullyParallel false, `testDir: './e2e'`,
//   CI-aware reporter/retries/forbidOnly), plus a `baseURL` resolver.
//
//   The stack is booted by the `globalSetup` (programmatic `runStack`,
//   see `global-setup.ts`), NOT by Playwright's `webServer`. Playwright's
//   `webServer` shells out (`pnpm dev`) and force-kills the supervisor on
//   teardown before its container drain finishes, orphaning containers;
//   the in-process `runStack` boot + `handle.stop` teardown drains cleanly.
//
// Load-bearing invariants this module enforces:
//   - `workers: 1` and `fullyParallel: false` — single supervisor per
//     stack; parallel tests would contend on shared faucet / wallet
//     / RPC (distilled § Invariants).
//   - `use.baseURL` settable at config-load time even with no manifest —
//     via cold-start fallback to a conventional URL (the stack the
//     globalSetup boots later answers on that conventional router host).
//
// This module returns `PlaywrightTestConfig`-shaped fragments. We do
// NOT import `@playwright/test` at module init: the types are
// structural and we accept the optional-peer cost rather than
// importing transitively from a build-integration that must be
// loadable without `@playwright/test` (matching the Vitest helpers'
// optional-peer pattern).

import { BUILT_IN_ENDPOINT_ALIASES } from '../runtime/conventional-routes.ts';
import { type ResolveStackContextOptions, resolveEndpointUrl } from './stack-context.ts';

// -----------------------------------------------------------------------------
// PlaywrightTestConfig shape (structural; we do NOT import the type
// directly to keep `@playwright/test` an optional peer)
// -----------------------------------------------------------------------------

type PlaywrightReporterShape = [string] | [string, Record<string, unknown>];
type PlaywrightGlobalSetupShape = string | string[];

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
const DEFAULT_ENDPOINT_NAME = BUILT_IN_ENDPOINT_ALIASES.app;

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
