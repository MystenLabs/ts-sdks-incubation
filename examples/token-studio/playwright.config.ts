import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` — the webServer's `pnpm dev` (devstack-next
// supervisor) owns stack bring-up. 300s timeout to cover sui-localnet
// bring-up + publish + vite spawn.
export default await defineDevstackPlaywrightConfig({
	port: 5173,
	extend: { webServer: { timeout: 300_000 } },
});
