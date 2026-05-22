import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

const env = {
	VITE_DEEPBOOK_TRADER_AUTO_APPROVE: '1',
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
