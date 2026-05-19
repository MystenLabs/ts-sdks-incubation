import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// 900s timeout — fork-mode's first-run cold start pulls `mysten/sui-tools`
// (hundreds of MB) and warms the upstream system-state on top of
// localnet bring-up; that can blow past playwright's 300s default. Warm
// runs take seconds.
export default defineDevstackPlaywrightConfig({ timeout: 900_000 });
