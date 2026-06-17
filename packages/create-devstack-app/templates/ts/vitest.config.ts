import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// Unit tests — fast, no devstack, no Docker. `devstackVitestTestConfig()`
// runs `tests/unit/**`; full-stack `tests/e2e/**` need a booted stack and run via
// `pnpm test:e2e` (see vitest.e2e.config.ts).
export default defineConfig({
	// Ignore `.devstack/` runtime churn so watch mode doesn't reload on
	// the supervisor's manifest ticks.
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
