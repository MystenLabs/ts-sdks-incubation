import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineDevstackConfig } from '../config.js';
import type { Env } from '../engine/types.js';
import { sui, type SuiState } from '../plugins/sui.js';
import { snapshotPathFor } from '../persistence/index.js';
import {
	getNodeState,
	readSnapshot,
	setupForTestWithConfig,
	teardownForTest,
} from './harness.js';

let appDir: string;
let env: Env;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-next-vitest-'));
	env = { appName: 'demo', appDir, network: 'testnet', stack: 'test' };
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

describe('vitest harness — programmatic', () => {
	it('runs a cycle, writes a snapshot, returns a handle', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupForTestWithConfig({ config, env });
		expect(handle.cycle.errored).toEqual([]);
		expect(handle.snapshotPath).toBe(snapshotPathFor(env));

		const snapshot = await readSnapshot(env);
		expect(snapshot).toBeDefined();
		// PreCondition for the next test — config discovery from cwd needs
		// a devstack.config.* file present. Skip that path here; this test
		// uses the lower-level *WithConfig entry which doesn't need disk.
		expect(Object.keys(snapshot!.nodeStates)).toContain('sui.testnet');

		await teardownForTest(handle);
	});

	it('exposes node state via getNodeState with a typed cast', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupForTestWithConfig({ config, env });
		const snapshot = await readSnapshot(env);
		const state = getNodeState<SuiState>(snapshot!, 'sui.testnet');
		expect(state.network).toBe('testnet');
		expect(state.rpcUrl).toContain('testnet.sui.io');
		await teardownForTest(handle);
	});

	it('throws on a missing node with an actionable message listing available nodes', async () => {
		const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
		const handle = await setupForTestWithConfig({ config, env });
		const snapshot = await readSnapshot(env);
		expect(() => getNodeState(snapshot!, 'sui.localnet')).toThrow(/no node 'sui\.localnet'/);
		expect(() => getNodeState(snapshot!, 'sui.localnet')).toThrow(/sui\.testnet/);
		await teardownForTest(handle);
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
			setupForTestWithConfig({ config, env: { ...env, network: 'mainnet' } }),
		).rejects.toThrow(/setup cycle errored/);
	});
});

describe('vitest harness — config discovery', () => {
	// `setupForTest` (without -WithConfig) runs the full env.ts loader,
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

		const { setupForTest } = await import('./harness.js');
		const handle = await setupForTest({ cwd: appDir, network: 'testnet', stack: 'test' });
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
			await teardownForTest(handle);
		}
	});
});
