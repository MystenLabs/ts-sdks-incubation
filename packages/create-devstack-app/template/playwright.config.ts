import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `pnpm dev` runs the public devstack lifecycle before starting Vite.
export default defineDevstackPlaywrightConfig({
	baseURL: 'http://dev.template.localhost:5175',
});
