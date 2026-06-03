import { defineConfig } from 'vitest/config';

// Unit tests for the scaffolder (fence stripper, plugin manifest, gitignore
// guard). The bundled `template/` directory is a SNAPSHOT of a full app — its
// `e2e/*.spec.ts` are Playwright specs that import `@playwright/test` and must
// never be collected by this package's vitest run. Scope `include` to `test/`
// and explicitly exclude `template/`.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'template/**'],
	},
});
