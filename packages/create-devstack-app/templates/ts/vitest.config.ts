import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Ignore `.devstack/` runtime churn so watch mode doesn't reload on
	// the supervisor's manifest ticks.
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig({
		// The suite runs real transactions against the live local stack.
		test: { testTimeout: 60_000 },
	}),
});
