import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
} from '@mysten-incubation/devstack/playwright';

// Browser tests run against a dedicated `e2e` stack (parallel-safe with a
// developer's `pnpm dev` on the `connect-four` stack). The stack is booted
// programmatically by the devstack `globalSetup` — `DEVSTACK_STACK=e2e` from
// the `test:e2e` script — and torn down after the run; `use.baseURL` resolves
// to the conventional router host for this stack
// (dev.e2e.connect-four.localhost:5175).
const stack = 'e2e' as const;

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ stack }),
	projects: devstackPlaywrightProjects(),
});
