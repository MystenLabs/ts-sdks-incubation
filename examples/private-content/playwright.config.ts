import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` — the webServer's `pnpm dev` (devstack-next
// supervisor) owns stack bring-up. 15-minute timeout because the
// first run has to build walrus (~10 min cargo) and seal (~5-8 min)
// images cold; warm runs are seconds.
export default await defineDevstackPlaywrightConfig({
	port: 5175,
	extend: { webServer: { timeout: 900_000 } },
});
