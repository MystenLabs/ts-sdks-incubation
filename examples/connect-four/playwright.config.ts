import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

const baseURL = 'http://dev.connect-four.connect-four.localhost:5175';
const env = {
	VITE_CONNECT_FOUR_AUTO_APPROVE: '1',
};

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({ baseURL, env }),
});
