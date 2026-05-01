import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default defineDevstackPlaywrightConfig({
	port: 5174,
	manageStack: true,
	extend: {
		// Vite is fast on a warm stack but devstack's webServer command is
		// `pnpm dev` (= `devstack watch`), which goes through one reconcile
		// cycle before the dev-server settles. The 60s default is tight on a
		// cold image cache.
		webServer: {
			command: 'pnpm dev',
			url: 'http://localhost:5174',
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
	},
});
