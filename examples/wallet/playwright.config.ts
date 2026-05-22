import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

import { WALLET_ROUTER_DEV_ORIGIN } from './dev-origin.ts';

export default defineDevstackPlaywrightConfig({
	baseURL: WALLET_ROUTER_DEV_ORIGIN,
	env: {
		VITE_WALLET_AUTO_APPROVE: '1',
	},
});
