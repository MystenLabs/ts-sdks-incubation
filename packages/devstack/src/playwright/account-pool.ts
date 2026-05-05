// Playwright fixture for `AccountPool` — hands out pre-funded keypairs
// to tests one at a time. Mirrors the vitest `globalSetup` integration:
// reads the per-stack manifest to discover the localnet's sui-rpc +
// sui-faucet URLs, instantiates a session-scoped pool (one per worker),
// exposes `lease()` / `release()` via Playwright's `test.use()`.
//
// Use for tests that need fresh-funded keypairs without faucet calls in
// the hot path. Note: leased accounts are NOT exposed through the dev
// wallet UI — they're meant for programmatic Sui client signing. Tests
// that drive the wallet adapter UI (`connectAs(page, 'alice')`) should
// keep using named accounts from `DevstackConfig.accounts`.
//
// Worked example:
//
//   import { test } from '@mysten-incubation/devstack/playwright/account-pool';
//
//   test('concurrent transfers', async ({ pool }) => {
//     const sender = await pool.lease();
//     const recipient = await pool.lease();
//     try {
//       // ... use sender.account.keypair to sign a programmatic tx
//       //     transferring SUI to recipient.account.address
//     } finally {
//       sender.release();
//       recipient.release();
//     }
//   });
//
// The pool's idempotent prefund means warm runs cost zero faucet calls;
// snapshot restore brings the prefunded balances back.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test as base } from '@playwright/test';

import type { Manifest } from '../runtime/manifest-types.js';
import { AccountPool, type Lease } from '../vitest/accountPool.js';

export interface DevstackAccountPoolFixtures {
	/** Session-scoped (one per worker). Constructs an `AccountPool` from the
	 * manifest's sui-rpc + sui-faucet services and pre-funds N accounts. */
	pool: AccountPool;
	/** Per-test lease. Auto-released when the test fixture tears down. */
	account: Lease;
}

let sessionPool: AccountPool | undefined;

/** Playwright `test` extended with `pool` and `account` fixtures. Apps
 * import this `test` instead of `@playwright/test`'s default `test` to
 * opt into the AccountPool. */
export const test = base.extend<DevstackAccountPoolFixtures>({
	// eslint-disable-next-line no-empty-pattern
	pool: async ({}, use) => {
		if (sessionPool === undefined) {
			sessionPool = await constructPool();
			await sessionPool.seed();
		}
		await use(sessionPool);
	},
	account: async ({ pool }, use) => {
		const lease = await pool.lease();
		try {
			await use(lease);
		} finally {
			lease.release();
		}
	},
});

export { expect } from '@playwright/test';

async function constructPool(): Promise<AccountPool> {
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	const manifestPath =
		process.env.DEVSTACK_MANIFEST_PATH ??
		resolve(process.cwd(), '.devstack', 'stacks', stack, 'manifest.json');
	if (!existsSync(manifestPath)) {
		throw new Error(
			`devstack/playwright AccountPool: manifest not found at ${manifestPath}. ` +
				`Run \`devstack up --stack ${stack}\` (or set DEVSTACK_MANIFEST_PATH) first.`,
		);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
	const services = manifest.registry.services as Array<{ name: string; url: string }>;
	const rpcUrl = services.find((s) => s.name === 'sui-rpc')?.url;
	const faucetUrl = services.find((s) => s.name === 'sui-faucet')?.url;
	if (rpcUrl === undefined) {
		throw new Error(
			`devstack/playwright AccountPool: no sui-rpc service in ${manifestPath}. ` +
				`Bring the sui plugin up before running these tests.`,
		);
	}
	if (faucetUrl === undefined) {
		throw new Error(
			`devstack/playwright AccountPool: no sui-faucet service in ${manifestPath}.`,
		);
	}
	const size = numberFromEnv('DEVSTACK_POOL_SIZE');
	const fundEach = bigintFromEnv('DEVSTACK_POOL_FUND_EACH');
	return new AccountPool({
		rpcUrl,
		faucetUrl,
		size,
		fundEach,
		prefund: process.env.DEVSTACK_SKIP_PREFUND !== '1',
	});
}

function numberFromEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.length === 0) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function bigintFromEnv(name: string): bigint | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.length === 0) return undefined;
	try {
		return BigInt(raw);
	} catch {
		return undefined;
	}
}
