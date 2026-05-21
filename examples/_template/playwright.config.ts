import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `pnpm dev` runs the public devstack lifecycle before starting Vite.
// The preset reads the manifest from the runtime root and resolves
// `baseURL` from the `app` endpoint.
export default defineDevstackPlaywrightConfig();
