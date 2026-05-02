import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default defineDevstackPlaywrightConfig({
	port: 5174,
	manageStack: true,
	extend: {
		// Vite is fast on a warm stack but devstack's webServer command is
		// `pnpm dev` (= `devstack up`, keepalive), which goes through one
		// reconcile cycle before the dev-server settles. The defineConfig
		// default (300s for managed stacks) covers cold sui; this app
		// imports deepbook so we leave headroom but keep it tighter than
		// private-content's needs.
		webServer: {
			command: 'pnpm dev',
			url: 'http://localhost:5174',
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
	},
});
