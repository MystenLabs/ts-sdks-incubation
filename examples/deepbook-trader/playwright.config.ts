import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

const env = {
	// Single devstack-wide switch the Vite plugin reads to auto-approve
	// dev-wallet signing requests (replaces per-app VITE_*_AUTO_APPROVE).
	DEVSTACK_AUTO_APPROVE: '1',
};
const stack = 'deepbook-trader' as const;
const baseURL = 'http://dev.deepbook-trader.deepbook-trader.localhost:5175';

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({
		baseURL,
		stack,
		env,
	}),
});
