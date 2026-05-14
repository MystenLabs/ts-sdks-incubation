import { defineConfig } from 'vitest/config';

// Plain vitest config. Wire devstack into chain-mode tests via
// `withDevstack` from `@mysten-incubation/devstack-effect/vitest`.
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts?(x)'],
		exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
		passWithNoTests: true,
	},
});
