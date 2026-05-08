// Default Vitest globalSetup wired in by `defineDevstackVitestConfig({ chain:
// true })`. Reads the per-app manifest from the test stack (so e2e/chain
// tests don't trample on the dev `main` stack), pre-funds a session-scoped
// AccountPool on the chain, and exposes endpoints + manifest to test files
// via Vitest's `provide()` context.
//
// Path resolution is delegated to `findManifestForCwd` (shared with the
// Playwright account-pool fixture); the only stack-specific tweak here is
// the `'test'` default — `pnpm test` should bring up an isolated localnet
// via `devstack up --stack test --once` instead of reusing dev state. Apps
// can opt back into the dev stack with `DEVSTACK_STACK=main`.
//
// Test files reach the context with:
//
//   import { injectDevstackContext, AccountPool } from '@mysten-incubation/devstack/vitest/runtime';
//   const ctx = injectDevstackContext();
//   const pool = new AccountPool({ rpcUrl: ctx.rpcUrl, faucetUrl: ctx.faucetUrl });
//
// (Construct the pool inside a `beforeAll` and lease per-test inside
// `beforeEach` for proper isolation.) The previous `getSessionAccountPool()`
// helper was removed in 0.1.0 because Vitest re-imports modules per worker,
// so the module-level `pool` was always `undefined` outside the
// globalSetup process.

import { findManifestForCwd } from '../runtime/manifest-discovery.js';
import type { Manifest } from '../runtime/manifest-types.js';
import { AccountPool } from './accountPool.js';

export interface DevstackTestContext {
	rpcUrl: string;
	faucetUrl: string;
	/** Parsed manifest. Cast `manifest.registry` to your app's typed
	 * shape at the consuming site. */
	manifest: Manifest;
}

interface SetupArg {
	provide: (key: 'devstack', value: DevstackTestContext) => void;
}

export default async function setup({ provide }: SetupArg): Promise<() => Promise<void>> {
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	let discovery: { path: string; manifest: Manifest };
	try {
		discovery = findManifestForCwd({ stack });
	} catch (err) {
		throw new Error(
			`devstack/vitest globalSetup: ${err instanceof Error ? err.message : String(err)}\n` +
				`  Hint: run \`DEVSTACK_STACK=${stack} devstack up\` first.`,
		);
	}
	const { path: manifestPath, manifest } = discovery;

	const services = manifest.registry.services as Array<{ name: string; url: string }>;
	const rpcUrl = services.find((s) => s.name === 'sui-rpc')?.url;
	const faucetUrl = services.find((s) => s.name === 'sui-faucet')?.url;
	if (!rpcUrl) {
		throw new Error(
			`devstack/vitest globalSetup: no \`sui-rpc\` service in ${manifestPath}. Bring the sui plugin up before running chain-mode tests.`,
		);
	}
	if (!faucetUrl) {
		throw new Error(`devstack/vitest globalSetup: no \`sui-faucet\` service in ${manifestPath}.`);
	}

	const size = numberFromEnv('DEVSTACK_POOL_SIZE');
	const fundEach = bigintFromEnv('DEVSTACK_POOL_FUND_EACH');
	// Pre-fund the pool on-chain so test files don't pay the per-account
	// faucet cost. The pool object itself isn't shared with workers (Vitest
	// re-imports modules); test files instantiate their own `AccountPool`
	// with the same mnemonic+rpcUrl in a `beforeAll` and lease from there.
	const seedingPool = new AccountPool({
		rpcUrl,
		faucetUrl,
		size,
		fundEach,
		prefund: process.env.DEVSTACK_SKIP_PREFUND !== '1',
	});
	await seedingPool.seed();

	provide('devstack', { rpcUrl, faucetUrl, manifest });

	return async () => {
		// The chain is owned by `devstack up` outside the test process. Nothing
		// to tear down here; the pool's leased accounts persist on-chain so
		// subsequent runs reuse the funded balances.
	};
}

function numberFromEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function bigintFromEnv(name: string): bigint | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	try {
		return BigInt(raw);
	} catch {
		return undefined;
	}
}
