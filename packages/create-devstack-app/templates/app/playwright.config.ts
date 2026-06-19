import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
} from '@mysten-incubation/devstack/playwright';

// Browser tests (`tests/browser/**`) run against a dedicated `e2e` stack,
// parallel-safe with a developer's `pnpm dev` on the `dev` stack and with the
// `test` stack `pnpm test:e2e` boots. The stack is booted programmatically by
// the devstack `globalSetup` (wired in by `devstackPlaywrightBaseConfig`) —
// `DEVSTACK_STACK=e2e` from the `test:browser` script — and torn down after the
// run; `use.baseURL` resolves to the conventional router host for this stack.
const stack = 'e2e' as const;

export default defineConfig({
	// `devstackPlaywrightBaseConfig()` already points `testDir` at `tests/browser`
	// (and wires the stack-booting `globalSetup`), so vitest's `tests/e2e` and
	// `tests/unit` are never picked up by Playwright.
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ stack }),
	projects: devstackPlaywrightProjects(),
});
