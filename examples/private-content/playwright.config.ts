import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

import { PRIVATE_CONTENT_APP_ORIGIN } from './devstack.shared.ts';

const env = {
	VITE_PRIVATE_CONTENT_AUTO_APPROVE: '1',
};

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL: PRIVATE_CONTENT_APP_ORIGIN }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({
		baseURL: PRIVATE_CONTENT_APP_ORIGIN,
		env,
	}),
});
