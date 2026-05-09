import { test as base, type TestType } from '@playwright/test';
import type { DevstackConfig, Env } from '../engine/types.js';
import {
	setupForTest,
	setupForTestWithConfig,
	teardownForTest,
	type SetupHandle,
} from '../vitest/harness.js';

// Playwright fixture for devstack. Each worker brings up its own stack
// — `e2e-${workerIndex}` by default — by running one engine cycle, then
// hands the test a SetupHandle. Tests pull the stack's endpoints out of
// `handle.engine.getState()` (or `handle.cycle` for the cycle summary).
//
// The fixture is **worker-scoped**: one stack per worker, reused across
// all tests that worker runs. That's the right granularity for a stack
// that takes seconds-to-minutes to bring up; per-test would multiply
// the wall-clock cost. Tests that need a clean slate within the same
// worker can call `engine.invalidate(name)` + `engine.runOnce()`
// themselves — the fixture's job is the bring-up, not the per-test
// reset semantics.

// Worker-scoped fixture, so it lands on the worker-fixtures slot of
// TestType (the second generic parameter), not the per-test slot.
export interface DevstackWorkerFixtures {
	devstack: SetupHandle;
}

export interface CreateDevstackFixtureOptions {
	/** In-memory config. Skips disk discovery — useful for tests that
	 * compose the stack programmatically. */
	config?: DevstackConfig;
	/** When `config` is set, you must also supply env (or at least
	 * appName + appDir). The fixture derives `stack` per worker. */
	envBase?: Omit<Env, 'stack'>;
	/** Path to devstack.config.ts (default: walk up from cwd). Used
	 * when `config` is not provided. */
	configPath?: string;
	/** Network. Default 'localnet'. */
	network?: string;
	/** Override the per-worker stack-name pattern. Default
	 * `(workerIndex) => `e2e-${workerIndex}``. */
	stackName?: (workerIndex: number) => string;
}

export function createDevstackFixture(
	opts: CreateDevstackFixtureOptions = {},
): TestType<{}, DevstackWorkerFixtures> {
	const stackOf = opts.stackName ?? ((idx: number) => `e2e-${idx}`);

	return base.extend<{}, DevstackWorkerFixtures>({
		// Worker-scoped: one bring-up per worker, reused across all of
		// that worker's tests. The third tuple slot { scope: 'worker' }
		// is the playwright API for that.
		devstack: [
			async ({}, use, workerInfo) => {
				const stack = stackOf(workerInfo.workerIndex);
				let handle: SetupHandle;
				if (opts.config !== undefined) {
					if (opts.envBase === undefined) {
						throw new Error(
							'createDevstackFixture: when `config` is set, `envBase` must also be supplied',
						);
					}
					handle = await setupForTestWithConfig({
						config: opts.config,
						env: { ...opts.envBase, stack },
					});
				} else {
					handle = await setupForTest({
						...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
						...(opts.network !== undefined ? { network: opts.network } : {}),
						stack,
					});
				}

				try {
					await use(handle);
				} finally {
					await teardownForTest(handle);
				}
			},
			{ scope: 'worker' },
		],
	});
}

// Default-export a pre-extended `test` for the common case where the
// user just wants discovery-based bring-up against the cwd's
// devstack.config.ts. Power users override via `createDevstackFixture`.
export const test = createDevstackFixture();
export { expect } from '@playwright/test';
