import { defineConfig, type ViteUserConfig } from 'vitest/config';

export interface DevstackVitestConfigOptions {
	/** Extra `test` fields merged into the resulting config. */
	readonly test?: NonNullable<ViteUserConfig['test']>;
}

/**
 * Build the canonical devstack Vitest config. Apps reduce their
 * `vitest.config.ts` to a single call:
 *
 *   import { defineDevstackVitestConfig }
 *     from '@mysten-incubation/devstack/vitest';
 *
 *   export default defineDevstackVitestConfig();
 *
 * Bundles: `src/**\/*.{test,spec}.ts?(x)` includes, `e2e/`, `dist/`,
 * `.turbo/`, `node_modules` excludes, and `passWithNoTests: true` so
 * codegen-derived stacks without unit tests yet don't fail CI.
 *
 * For chain-mode integration tests against a real devstack, build the
 * devstack handle and pass `handle.layer` to `@effect/vitest`'s
 * `it.layer(...)` directly — no thin wrapper is shipped.
 */
export function defineDevstackVitestConfig(
	options: DevstackVitestConfigOptions = {},
): ViteUserConfig {
	return defineConfig({
		test: {
			include: ['src/**/*.{test,spec}.ts?(x)'],
			exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
			passWithNoTests: true,
			...options.test,
		},
	});
}
