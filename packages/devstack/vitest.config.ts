import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**'],
		setupFiles: ['./test-setup/isolate-port-locks.ts'],
	},
});
