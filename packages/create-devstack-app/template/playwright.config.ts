import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `pnpm dev` (the devstack supervisor) owns stack bring-up + writes the
// manifest. 300s timeout covers sui-localnet bring-up + publish + vite
// spawn.
export default defineDevstackPlaywrightConfig();
