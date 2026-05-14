import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assertType, beforeEach, describe, expect, it } from 'vitest';
import { defineDevstackConfig } from '../config.js';
import type { Env } from '../engine/types.js';
import { manifest } from '../plugins/manifest.js';
import { sui, type SuiState } from '../plugins/sui.js';
import { snapshotPathFor } from '../persistence/index.js';
import type { Manifest } from '../shapes/index.js';
import {
	getNodeState,
	readManifest,
	readSnapshot,
	setupWithConfig,
	teardown,
} from './harness.js';

let appDir: string;
let env: Env;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-vitest-'));
	env = { appName: 'demo', appDir, network: 'testnet', stack: 'test' };
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

describe('vitest harness — programmatic', () => {
	it('runs a cycle, writes a snapshot, returns a handle', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupWithConfig({ config, env });
		expect(handle.cycle.errored).toEqual([]);
		expect(handle.snapshotPath).toBe(snapshotPathFor(env));

		const snapshot = await readSnapshot(env);
		expect(snapshot).toBeDefined();
		// PreCondition for the next test — config discovery from cwd needs
		// a devstack.config.* file present. Skip that path here; this test
		// uses the lower-level *WithConfig entry which doesn't need disk.
		expect(Object.keys(snapshot!.nodeStates)).toContain('sui.testnet');

		await teardown(handle);
	});

	it('exposes node state via getNodeState with a typed cast', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupWithConfig({ config, env });
		const snapshot = await readSnapshot(env);
		const state = getNodeState<SuiState>(snapshot!, 'sui.testnet');
		expect(state.network).toBe('testnet');
		expect(state.rpcUrl).toContain('testnet.sui.io');
		await teardown(handle);
	});

	it('throws on a missing node with an actionable message listing available nodes', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupWithConfig({ config, env });
		const snapshot = await readSnapshot(env);
		expect(() => getNodeState(snapshot!, 'sui.localnet')).toThrow(/no node 'sui\.localnet'/);
		expect(() => getNodeState(snapshot!, 'sui.localnet')).toThrow(/sui\.testnet/);
		await teardown(handle);
	});

	it('readSnapshot via discovery returns undefined when setup has not run', async () => {
		// Exercises the discovery path: a config file present but no
		// snapshot. Write a stub so the discovery path succeeds, then
		// assert no snapshot exists yet.
		await writeFile(
			join(appDir, 'package.json'),
			JSON.stringify({ name: 'demo', type: 'module' }),
		);
		await writeFile(
			join(appDir, 'devstack.config.ts'),
			`export default { stack: [] };
`,
		);
		const snapshot = await readSnapshot({ cwd: appDir, network: 'testnet', stack: 'test' });
		expect(snapshot).toBeUndefined();
	});

	it('throws when the setup cycle errors, with engine torn down cleanly', async () => {
		// Mainnet faucet throws when consumed — surfaces the error path.
		const consumer = (await import('../factories/define.js')).define({
			name: 'consumer',
			deps: { f: sui.get('faucet') },
			start: async ({ deps: { f } }) => ({ url: f.url }),
		});
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'mainnet' }), consumer] });
		await expect(
			setupWithConfig({ config, env: { ...env, network: 'mainnet' } }),
		).rejects.toThrow(/setup cycle errored/);
	});
});

describe('vitest harness — readManifest', () => {
	function manifestEnv(): Env {
		return { appName: 'demo', appDir, network: 'localnet', stack: 'test' };
	}

	it('returns undefined when no manifest sidecar exists', async () => {
		const result = await readManifest(manifestEnv());
		expect(result).toBeUndefined();
	});

	it('reads the JSON sidecar written by the manifest plugin', async () => {
		// Manifest-only config (no sui/docker) — manifest plugin writes
		// manifest.json into <appDir>/.devstack/stacks/test/ unconditionally.
		const m = manifest({ output: 'src/generated/manifest.ts' });
		const config = defineDevstackConfig({ stack: [m] });
		const handle = await setupWithConfig({ config, env: manifestEnv() });
		try {
			const read = await readManifest(manifestEnv());
			expect(read).toBeDefined();
			expect(read!.packages).toEqual([]);
			expect(read!.endpoints).toEqual([]);
			expect(read!.accounts).toEqual([]);
			expect(read!.coins).toEqual([]);
			expect(read!.extras).toEqual({});
		} finally {
			await teardown(handle);
		}
	});

	it('Manifest type defaults to Record<string, unknown> for extras', async () => {
		const result = await readManifest(manifestEnv());
		assertType<Manifest<Record<string, unknown>> | undefined>(result);
	});

	it('Manifest<TExtras> generic preserves app-specific extras typing', () => {
		type AppExtras = { token: string; sessionId: number };
		const m: Manifest<AppExtras> = {
			packages: [],
			endpoints: [],
			accounts: [],
			coins: [],
			extras: { token: 'abc', sessionId: 42 },
		};
		assertType<string>(m.extras.token);
		assertType<number>(m.extras.sessionId);
		// Verify the generic threads through readManifest's return type.
		const fn = async () => readManifest<AppExtras>();
		assertType<() => Promise<Manifest<AppExtras> | undefined>>(fn);
	});
});

describe('vitest harness — config discovery', () => {
	// `setup` (without -WithConfig) runs the full env.ts loader,
	// which dynamic-imports devstack.config.ts. Verify against a written-
	// to-disk config so the discovery path is exercised end-to-end.
	// Anchored to this test file's location so the synthetic config can
	// import the package's source by absolute path — vite-node handles
	// the `.ts` transform.
	it('walks up from cwd to find devstack.config.ts and applies', async () => {
		const pkgRoot = join(import.meta.dirname, '..', '..');
		await writeFile(
			join(appDir, 'package.json'),
			JSON.stringify({ name: 'demo', type: 'module' }),
		);
		await writeFile(
			join(appDir, 'devstack.config.ts'),
			`import { defineDevstackConfig } from '${pkgRoot}/src/config.ts';
import { sui } from '${pkgRoot}/src/plugins/sui.ts';
export default defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
`,
		);

		const { setup } = await import('./harness.js');
		const handle = await setup({ cwd: appDir, network: 'testnet', stack: 'test' });
		try {
			expect(handle.cycle.errored).toEqual([]);
			expect(handle.env.appName).toBe('demo');
			expect(handle.configPath).toBe(join(appDir, 'devstack.config.ts'));
			// Exercise the discovery-based readSnapshot, mirroring real
			// per-test usage where the test has no in-memory env.
			const snapshot = await readSnapshot({ cwd: appDir, network: 'testnet', stack: 'test' });
			expect(snapshot).toBeDefined();
			expect(Object.keys(snapshot!.nodeStates)).toContain('sui.testnet');
		} finally {
			await teardown(handle);
		}
	});
});
