import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` — the webServer's `pnpm dev` (devstack-next
// supervisor) owns stack bring-up.
export default await defineDevstackPlaywrightConfig({
	port: 5174,
	extend: {
		// `pnpm dev` brings up sui + deepbook publish + pool creation —
		// give the webServer enough room for a cold cargo build.
		webServer: { timeout: 300_000 },
	},
});
