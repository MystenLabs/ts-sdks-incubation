import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// Unit tests — fast, no devstack, no Docker. `devstackVitestTestConfig()`
// excludes `*.e2e.test.ts`. Full-stack browser coverage is the Playwright
// `pnpm test:e2e` suite, which boots an isolated `e2e` stack.
export default defineConfig({
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
