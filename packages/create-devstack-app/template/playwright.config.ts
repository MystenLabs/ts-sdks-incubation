import { defineConfig } from '@playwright/test';
import {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
} from '@mysten-incubation/devstack/playwright';

// `pnpm dev` runs the public devstack lifecycle before starting Vite.
// Router hostname follows the substrate convention
// `<service>.<stack>.<app>.localhost:<port>` (see
// packages/devstack/src/build-integrations/runtime/conventional-routes.ts).
const baseURL = 'http://dev.template.template.localhost:5175';
const env = {
	VITE_TEMPLATE_AUTO_APPROVE: '1',
};

export default defineConfig({
	...devstackPlaywrightBaseConfig(),
	use: devstackPlaywrightUse({ baseURL }),
	projects: devstackPlaywrightProjects(),
	webServer: devstackPlaywrightWebServer({ baseURL, env }),
});
