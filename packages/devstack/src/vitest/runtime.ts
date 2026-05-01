// Runtime surface for the @mysten-incubation/devstack/vitest subpath. Imported by
// test files (and devstack's own globalSetup) — Vitest loads these through
// vite-node where `.js` → `.ts` resolution works, so the transitive imports
// here are safe.
//
// Apps' `vitest.config.ts` should import from `@mysten-incubation/devstack/vitest`
// instead (config-load surface, zero transitive imports).

export {
	AccountPool,
	type AccountPoolOptions,
	DEFAULT_FUND_EACH,
	DEFAULT_MNEMONIC,
	DEFAULT_POOL_SIZE,
	type Lease,
	type SeedAccount,
} from './accountPool.js';
export { type DevstackTestContext, getSessionAccountPool } from './globalSetup.js';
