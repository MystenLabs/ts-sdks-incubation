import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` — the webServer's `pnpm dev` (devstack-next
// supervisor) owns stack bring-up.
export default await defineDevstackPlaywrightConfig({ port: 5180 });
