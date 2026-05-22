import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

import { PRIVATE_CONTENT_APP_ORIGIN } from './devstack.shared.ts';

export default defineDevstackPlaywrightConfig({
	baseURL: PRIVATE_CONTENT_APP_ORIGIN,
	env: {
		VITE_PRIVATE_CONTENT_AUTO_APPROVE: '1',
	},
});
