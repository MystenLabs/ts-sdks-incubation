import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// E2E (full-stack) tests — `tests/e2e/**`. `autoBoot: true` boots a
// dedicated `test` stack before the run (codegen included) and tears it
// down after, so this is self-contained and runs in parallel with a
// `pnpm dev` stack. The Vite plugin resolves `@generated` to the active
// (test) stack's codegen output, so deployed package ids + endpoints are
// the test stack's.
export default defineConfig({
	plugins: [devstackVitePlugin()],
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig({
		autoBoot: true,
		// Real transactions against a freshly-booted local stack.
		test: { testTimeout: 60_000 },
	}),
});
