import { defineConfig } from 'vitest/config';

// Unit tests for the scaffolder (config renderer, scaffold engine, skip-set
// guards). The bundled `templates/` are complete authored apps — they carry
// their own vitest configs/tests that must never be collected by this
// package's run. Scope `include` to `test/` and exclude the templates.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'template/**', 'templates/**'],
	},
});
