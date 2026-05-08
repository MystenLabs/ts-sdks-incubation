// Runtime surface for the @mysten-incubation/devstack/vitest subpath. Imported by
// test files (and devstack's own globalSetup) — Vitest loads these through
// vite-node where `.js` → `.ts` resolution works, so the transitive imports
// here are safe.
//
// Apps' `vitest.config.ts` should import from `@mysten-incubation/devstack/vitest`
// instead (config-load surface, zero transitive imports).

import type { DevstackTestContext } from './globalSetup.js';

export {
	AccountPool,
	type AccountPoolOptions,
	DEFAULT_FUND_EACH,
	DEFAULT_MNEMONIC,
	DEFAULT_POOL_SIZE,
	type Lease,
	type SeedAccount,
} from './accountPool.js';
export { type DevstackTestContext } from './globalSetup.js';

// Augment Vitest's `ProvidedContext` so anyone using `inject('devstack')`
// from `'vitest'` directly gets the right typing too. The augmentation
// is type-only — this module does NOT import from `'vitest'` (Vitest's
// main entry runs `createExpect()` at module-load time, which throws
// outside a Vitest worker; pulling it in eagerly would break the
// dist-import smoke-test and any non-test consumer crawling the
// package surface).
declare module 'vitest' {
	interface ProvidedContext {
		devstack: DevstackTestContext;
	}
}

interface VitestWorkerState {
	providedContext?: Record<string, unknown>;
}

/** Typed accessor for the `DevstackTestContext` provided by
 * `defineDevstackVitestConfig({ chain: true })`'s globalSetup —
 * `rpcUrl`, `faucetUrl`, and the parsed manifest. Throws if globalSetup
 * hasn't run (e.g. you forgot to opt in to chain mode, or you called
 * this from a script outside a Vitest worker).
 *
 * Construct an `AccountPool` from the returned context inside a
 * `beforeAll` for per-test account leasing:
 *
 *   import { beforeAll } from 'vitest';
 *   import { AccountPool, injectDevstackContext } from '@mysten-incubation/devstack/vitest/runtime';
 *
 *   let pool: AccountPool;
 *   beforeAll(async () => {
 *     const ctx = injectDevstackContext();
 *     pool = new AccountPool({ rpcUrl: ctx.rpcUrl, faucetUrl: ctx.faucetUrl, prefund: false });
 *     await pool.seed();
 *   });
 *
 * Reads Vitest's per-worker state directly off `globalThis.__vitest_worker__`
 * (the same internal pointer Vitest's own `inject` uses) so this module
 * doesn't need to `import` from `'vitest'` — keeps the runtime surface
 * importable from non-test contexts (smoke-test, codegen, etc.).
 */
export function injectDevstackContext(): DevstackTestContext {
	const worker = (globalThis as Record<string, unknown>).__vitest_worker__ as
		| VitestWorkerState
		| undefined;
	if (worker === undefined) {
		throw new Error(
			'devstack/vitest: injectDevstackContext() called outside a Vitest worker. ' +
				'This helper only works inside test files run by `vitest`.',
		);
	}
	const ctx = worker.providedContext?.devstack as DevstackTestContext | undefined;
	if (ctx === undefined) {
		throw new Error(
			"devstack/vitest: inject('devstack') returned undefined. Ensure " +
				'`defineDevstackVitestConfig({ chain: true })` is set in vitest.config.ts ' +
				'and that `devstack up` has brought the test stack online.',
		);
	}
	return ctx;
}
