import { defineConfig } from 'vitest/config';

// Default vitest config. Excludes `src/integration/**` so the fast
// suite (`pnpm test`) doesn't fire up real sui / walrus / seal
// containers — those run via `pnpm test:integration` against a
// separate config.
export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**', 'src/integration/**'],
	},
});
