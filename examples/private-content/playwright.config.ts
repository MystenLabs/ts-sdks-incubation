import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// 900s timeout — first run builds walrus (~10 min cargo) and seal (~5-8
// min) images cold. Warm runs take seconds.
export default defineDevstackPlaywrightConfig({ timeout: 900_000 });
