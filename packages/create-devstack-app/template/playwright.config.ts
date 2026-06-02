import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

// E2E runs against a dedicated `test` stack, distinct from `pnpm dev`'s
// default `primary` stack. The webServer's `pnpm dev` brings its own
// stack up, so there is no manual apply step. Router hostname follows
// the substrate convention `<service>.<stack>.<app>.localhost:<port>`
// (see packages/devstack/src/build-integrations/runtime/conventional-routes.ts).
const baseURL = 'http://dev.test.template.localhost:5175';
const env = {
	// Single devstack-wide switch the Vite plugin reads to auto-approve
	// dev-wallet signing requests (replaces per-app VITE_*_AUTO_APPROVE).
	DEVSTACK_AUTO_APPROVE: '1',
};

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({
		baseURL,
		stack: 'test',
		command: 'DEVSTACK_APP=template DEVSTACK_STACK=test pnpm dev',
		env,
	}),
});
