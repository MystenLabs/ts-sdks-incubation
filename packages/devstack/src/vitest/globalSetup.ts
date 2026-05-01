// Default Vitest globalSetup wired in by `defineDevstackVitestConfig({ chain:
// true })`. Reads the per-app manifest from the test stack (so e2e/chain
// tests don't trample on the dev `main` stack), instantiates a session-scoped
// AccountPool, and exposes endpoints + the pool to test files via Vitest's
// `provide()` context.
//
// Path resolution order:
//   1. DEVSTACK_MANIFEST_PATH env var (full override)
//   2. `<cwd>/.devstack/stacks/<DEVSTACK_STACK ?? 'test'>/manifest.json`
//
// The default `'test'` stack means `pnpm test` brings up an isolated
// localnet via `devstack up --stack test --once` instead of reusing dev
// state. Apps can opt back into the dev stack with `DEVSTACK_STACK=main`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Manifest } from '../runtime/manifest-writer.js';
import { AccountPool } from './accountPool.js';

export interface DevstackTestContext {
	rpcUrl: string;
	faucetUrl: string;
	/** Parsed manifest. Cast `manifest.registry` to your app's typed
	 * shape at the consuming site. */
	manifest: Manifest;
}

let pool: AccountPool | undefined;

interface SetupArg {
	provide: (key: 'devstack', value: DevstackTestContext) => void;
}

export default async function setup({ provide }: SetupArg): Promise<() => Promise<void>> {
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	const manifestPath =
		process.env.DEVSTACK_MANIFEST_PATH ??
		resolve(process.cwd(), '.devstack', 'stacks', stack, 'manifest.json');
	if (!existsSync(manifestPath)) {
		throw new Error(
			`devstack/vitest globalSetup: manifest not found at ${manifestPath}. Run \`pnpm localnet:up --stack ${stack}\` first (or set DEVSTACK_STACK / DEVSTACK_MANIFEST_PATH).`,
		);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

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
	pool = new AccountPool({
		rpcUrl,
		faucetUrl,
		size,
		fundEach,
		prefund: process.env.DEVSTACK_SKIP_PREFUND !== '1',
	});
	await pool.seed();

	provide('devstack', { rpcUrl, faucetUrl, manifest });

	return async () => {
		// The chain is owned by `devstack up` outside the test process. Nothing
		// to tear down here; the pool's leased accounts persist on-chain so
		// subsequent runs reuse the funded balances.
	};
}

/** Accessor for the session AccountPool from inside a test file's setup
 * hook. Throws if globalSetup hasn't run (e.g. you imported this from a
 * spec running outside Vitest). */
export function getSessionAccountPool(): AccountPool {
	if (!pool) {
		throw new Error(
			'devstack/vitest: getSessionAccountPool() called before globalSetup ran. Ensure `defineDevstackVitestConfig({ chain: true })` is in vitest.config.ts.',
		);
	}
	return pool;
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
