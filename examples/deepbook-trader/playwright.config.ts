import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default defineDevstackPlaywrightConfig({
	baseURL: 'http://127.0.0.1:5182',
	env: {
		VITE_DEEPBOOK_TRADER_AUTO_APPROVE: '1',
	},
});
