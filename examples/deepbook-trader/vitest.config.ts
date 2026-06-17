import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// Unit tests (`tests/unit/**`) — fast, no devstack, no Docker. Full-stack
// browser coverage is the Playwright
// `pnpm test:browser` suite, which boots an isolated `e2e` stack.
export default defineConfig({
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
