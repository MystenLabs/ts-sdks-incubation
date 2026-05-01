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
// Runtime helpers (AccountPool, getSessionAccountPool, DevstackTestContext)
// live at `@mysten-incubation/devstack/vitest/runtime` — Vitest loads test files +
// globalSetup through vite-node, which handles `.js` → `.ts` correctly.

import { fileURLToPath } from 'node:url';

import { type UserConfig, defineConfig, mergeConfig } from 'vitest/config';

const GLOBAL_SETUP = fileURLToPath(new URL('./globalSetup.ts', import.meta.url));

export interface DevstackVitestOptions {
	/** Globs to run as tests. Defaults to `src/**\/*.{test,spec}.{ts,tsx}`. */
	include?: string[];
	/** Globs to skip. Defaults to e2e + node_modules + dist + .turbo. */
	exclude?: string[];
	/** Bring up the devstack chain context: load the per-app manifest written
	 * by `devstack up`, seed an AccountPool, expose endpoints + pool to tests
	 * via Vitest's `inject('devstack')`. Default false (unit tests only).
	 * Apps that opt in must `pnpm localnet:up` before running tests. */
	chain?: boolean;
	/** Extend the resolved config with arbitrary Vitest options. Merged
	 * via `mergeConfig` (deep merge for objects, array concat for arrays). */
	extend?: UserConfig;
}

/**
 * Single-line Vitest config for dev-examples apps. Bakes in the same
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
					}
				: {}),
		},
	});
	return opts.extend ? mergeConfig(base, opts.extend) : base;
}
