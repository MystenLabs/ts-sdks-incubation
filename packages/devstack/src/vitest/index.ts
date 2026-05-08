// Vitest config-load surface for @mysten-incubation/devstack. Apps import
// `defineDevstackVitestConfig` from this file via the
// `@mysten-incubation/devstack/vitest` subpath in their `vitest.config.ts`.
//
// Why everything is inline:
//   Vitest 2.x's config loader uses plain Node ESM for transitive imports
//   inside external packages — no `.js` → `.ts` fallback. Re-exporting from
//   sibling .ts files (the way `playwright/index.ts` does) breaks here.
//   Keeping the config-load module fully self-contained (no `from './*.js'`)
//   sidesteps the issue.
//
// Runtime helpers (AccountPool, injectDevstackContext, DevstackTestContext)
// live at `@mysten-incubation/devstack/vitest/runtime` — Vitest loads test files +
// globalSetup through vite-node, which handles `.js` → `.ts` correctly.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type UserConfig, defineConfig, mergeConfig } from 'vitest/config';

// Match the extension to the consuming environment: workspace dev (running
// from `src/`) ships `.ts`; published `dist/` ships `.mjs`. Vitest loads
// globalSetup via vite-node which handles `.ts` in workspace dev, but
// consumers running against the published tarball get plain Node ESM and
// need `.mjs`. `endsWith` works across path-separator conventions (POSIX `/`
// and Windows `\`) where `includes('/src/vitest')` would falsely fail on
// Windows or falsely match on a project-path coincidence.
const here = dirname(fileURLToPath(import.meta.url));
const isSrc =
	here.endsWith(`${'/'}src${'/'}vitest`) || here.endsWith(`${'\\'}src${'\\'}vitest`);
const GLOBAL_SETUP = resolve(here, `globalSetup.${isSrc ? 'ts' : 'mjs'}`);

/** AccountPool tuning. Mirrors the playwright helper's shape. */
export interface DevstackVitestPoolOptions {
	size?: number;
	fundEach?: bigint;
	skipPrefund?: boolean;
}

export interface DevstackVitestOptions {
	/** Globs to run as tests. Defaults to `src/**\/*.{test,spec}.{ts,tsx}`. */
	include?: string[];
	/** Globs to skip. Defaults to e2e + node_modules + dist + .turbo. */
	exclude?: string[];
	/** Bring up the devstack chain context: load the per-app manifest written
	 * by `devstack up`, seed an AccountPool, expose endpoints + pool to tests
	 * via Vitest's `inject('devstack')`. Default false (unit tests only).
	 * Apps that opt in must `devstack up` before running tests. */
	chain?: boolean;
	/** AccountPool tuning. Only meaningful with `chain: true`. Translated
	 * to env vars at config-eval time so Vitest's globalSetup picks them
	 * up across the process boundary. */
	pool?: DevstackVitestPoolOptions;
	/** Extend the resolved config with arbitrary Vitest options. Merged
	 * via `mergeConfig` (deep merge for objects, array concat for arrays). */
	extend?: UserConfig;
}

/**
 * Single-line Vitest config for apps using devstack. Bakes in the same
 * defaults the four apps were duplicating: src-only test glob, e2e
 * exclusion, `passWithNoTests` (so app dirs without unit tests still
 * exit 0). `chain: true` wires in the devstack globalSetup that loads the
 * manifest and pre-funds the AccountPool.
 *
 * Usage:
 *
 *   import { defineDevstackVitestConfig } from '@mysten-incubation/devstack/vitest';
 *   export default defineDevstackVitestConfig();
 *
 *   // for integration tests that need a chain:
 *   export default defineDevstackVitestConfig({ chain: true });
 */
export function defineDevstackVitestConfig(opts: DevstackVitestOptions = {}): UserConfig {
	if (opts.pool !== undefined) {
		if (opts.pool.size !== undefined) {
			process.env.DEVSTACK_POOL_SIZE = String(opts.pool.size);
		}
		if (opts.pool.fundEach !== undefined) {
			process.env.DEVSTACK_POOL_FUND_EACH = opts.pool.fundEach.toString();
		}
		if (opts.pool.skipPrefund === true) {
			process.env.DEVSTACK_SKIP_PREFUND = '1';
		}
	}
	const base = defineConfig({
		test: {
			include: opts.include ?? ['src/**/*.{test,spec}.ts?(x)'],
			exclude: opts.exclude ?? ['e2e/**', 'node_modules', 'dist', '.turbo'],
			passWithNoTests: true,
			...(opts.chain
				? {
						globalSetup: [GLOBAL_SETUP],
						testTimeout: 60_000,
						hookTimeout: 120_000,
						// Pin tests to a single forked worker. Chain-mode tests
						// share a pre-funded AccountPool that's seeded once in
						// globalSetup — running multiple workers in parallel
						// would either re-seed (slow + faucet contention) or
						// race over the same lease pool (test interference).
						// Vitest 2.x's `pool: 'forks'` + `poolOptions.forks.
						// singleFork: true` keeps the simple shared-state model
						// that `injectDevstackContext()` callers expect.
						pool: 'forks',
						poolOptions: { forks: { singleFork: true } },
					}
				: {}),
		},
	});
	return opts.extend ? mergeConfig(base, opts.extend) : base;
}
