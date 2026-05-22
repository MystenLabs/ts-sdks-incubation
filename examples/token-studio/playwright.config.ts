import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default defineDevstackPlaywrightConfig({
	baseURL: 'http://dev.token-studio.token-studio.localhost:5175',
	env: {
		VITE_TOKEN_STUDIO_AUTO_APPROVE: '1',
	},
});
