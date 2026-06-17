import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// Unit tests — fast, no devstack, no Docker. This example is config-only
// (no app/UI), so there is no Playwright `test:e2e`; the single unit test
// asserts the stack config composes.
export default defineConfig({
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
