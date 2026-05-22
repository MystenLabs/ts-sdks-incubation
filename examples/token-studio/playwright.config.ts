import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

const baseURL = 'http://dev.token-studio.token-studio.localhost:5175';
const env = {
	VITE_TOKEN_STUDIO_AUTO_APPROVE: '1',
};

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({
		baseURL,
		env,
	}),
});
