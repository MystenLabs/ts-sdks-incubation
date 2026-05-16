import { defineConfig } from 'vitest/config';

// Plain vitest. `effect-app` is a Node CLI demo of
// `devstack(...).layer`, not a browser app; this config only runs the
// unit tests in `src/`. The chain-mode helpers (`withDevstack`) aren't
// wired here because the integration test stubs the `SuiTag` +
// account layers directly.
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts?(x)'],
		exclude: ['node_modules', 'dist', '.turbo'],
		passWithNoTests: true,
	},
});
