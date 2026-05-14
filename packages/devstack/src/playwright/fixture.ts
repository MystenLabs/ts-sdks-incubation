import { test as base, type TestType } from '@playwright/test';
import type { Env } from '../engine/types.js';
import { SignerPool } from '../leasing/signer-pool.js';
import type { Manifest } from '../shapes/index.js';
import { readManifest, setup, teardown, type SetupHandle } from '../vitest/harness.js';

// Pre-extended `test` for devstack-driven Playwright suites. Each
// worker brings up its own stack (`e2e-${workerIndex}` by default),
// settles it once, and exposes the resulting manifest + a per-worker
// SignerPool. Tests just import `test` / `expect` from
// `@mysten-incubation/devstack/playwright` and use them like any
// pre-extended Playwright `test`.
//
// Worker-scoped — one bring-up per worker, reused across all tests
// that worker runs. Per-test would multiply the wall-clock cost; if
// a test needs a clean slate it can release+re-acquire a fresh
// signer or call `signerPool.acquire()` with a known-fresh name.

export interface DevstackWorkerFixtures {
	/** Per-worker stack name. Default pattern: `e2e-${workerIndex}`. */
	stack: string;
	/** The manifest JSON sidecar written by the manifest plugin during
	 * this worker's bring-up. Worker-scoped: read once per worker. */
	manifest: Manifest;
	/** Convenience: the `sui-rpc` endpoint URL from the manifest.
	 * Throws at fixture setup if the manifest doesn't carry that
	 * endpoint — there's no localhost fallback. */
	rpcUrl: string;
	/** Per-worker `SignerPool` materialized from the manifest +
	 * keystore. Tests do `await signerPool.withLease(async (lease) =>
	 * { ... })` to safely share signers across spec files within a
	 * single worker. */
	signerPool: SignerPool;
}

export interface CreateDevstackTestOptions {
	/** Path to devstack.config.ts (default: walk up from cwd). */
	configPath?: string;
	/** Network. Default 'localnet'. */
	network?: string;
	/** Override the per-worker stack-name pattern. Default
	 *  `(workerIndex) => 'e2e-${workerIndex}'`. */
	stackName?: (workerIndex: number) => string;
}

// Worker-local map of stack-name → SetupHandle so the teardown phase
// can dispose what setup made without the fixture body having to thread
// the handle through every fixture.
interface WorkerState {
	handle: SetupHandle;
	env: Env;
}

export function createDevstackTest(
	opts: CreateDevstackTestOptions = {},
): TestType<{}, DevstackWorkerFixtures> {
	const stackOf = opts.stackName ?? ((idx: number) => `e2e-${idx}`);
	const stateByWorker = new Map<number, WorkerState>();

	return base.extend<{}, DevstackWorkerFixtures>({
		stack: [
			async ({}, use, workerInfo) => {
				const name = stackOf(workerInfo.workerIndex);
				// First fixture in the chain — eagerly print so a hung
				// worker is visible in the test log.
				process.stderr.write(`[devstack] worker ${workerInfo.workerIndex}: stack='${name}'\n`);
				await use(name);
			},
			{ scope: 'worker' },
		],

		manifest: [
			async ({ stack }, use, workerInfo) => {
				const handle = await setup({
					...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
					...(opts.network !== undefined ? { network: opts.network } : {}),
					stack,
				});
				stateByWorker.set(workerInfo.workerIndex, { handle, env: handle.env });
				const m = await readManifest(handle.env);
				if (m === undefined) {
					throw new Error(
						`[devstack/playwright] manifest not written by setup for stack '${stack}'. ` +
							`Does the devstack.config.ts include a manifest() plugin?`,
					);
				}
				try {
					await use(m);
				} finally {
					await teardown(handle);
					stateByWorker.delete(workerInfo.workerIndex);
				}
			},
			{ scope: 'worker' },
		],

		rpcUrl: [
			async ({ manifest }, use) => {
				const ep = manifest.endpoints.find((e) => e.name === 'sui-rpc');
				if (ep === undefined) {
					throw new Error(
						`[devstack/playwright] manifest has no 'sui-rpc' endpoint — is the sui() plugin in the stack?`,
					);
				}
				await use(ep.url);
			},
			{ scope: 'worker' },
		],

		signerPool: [
			async ({ manifest }, use, workerInfo) => {
				const state = stateByWorker.get(workerInfo.workerIndex);
				if (state === undefined) {
					throw new Error('[devstack/playwright] signerPool: setup state missing');
				}
				const pool = await SignerPool.fromManifest(manifest, state.env);
				try {
					await use(pool);
				} finally {
					pool.reportLeaks();
				}
			},
			{ scope: 'worker' },
		],
	});
}

// Default-export a pre-extended `test` for the common case: discovery-
// based bring-up against the cwd's devstack.config.ts, default network,
// default stack pattern. Power users override via `createDevstackTest`.
export const test = createDevstackTest();
export { expect } from '@playwright/test';
