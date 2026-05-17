import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**'],
		setupFiles: ['./test-setup/isolate-port-locks.ts'],
		// Pinned to `forks` because `isolate-port-locks.ts` creates one
		// tmpdir per worker via `mkdtempSync` + sets `DEVSTACK_PORT_LOCK_DIR`
		// on `process.env`. With `pool: 'threads'`, workers share the same
		// process and thus the same env var — port-lock isolation collapses
		// silently. Keep this pinned so a future config flip can't break the
		// invariant.
		pool: 'forks',
	},
});
