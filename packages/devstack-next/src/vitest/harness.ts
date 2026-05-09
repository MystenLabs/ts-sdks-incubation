import { Engine } from '../engine/class.js';
import type { CycleResult, DevstackConfig, Env, SnapshotRecord } from '../engine/types.js';
import { tryReadSnapshot, writeSnapshot } from '../persistence/index.js';
import { loadConfigAndEnv, resolveEnvOnly } from '../cli/env.js';

// L7 frontend for vitest. Two roles:
//
// 1. globalSetup — bring the stack to satisfaction once before any test
//    file runs, then write a snapshot the per-test code can read out-of-
//    process. teardown stops the engine.
//
// 2. test code — `readSnapshot()` returns the on-disk SnapshotRecord so
//    a test can pull endpoints / package IDs / etc. without re-invoking
//    the engine.
//
// The pattern is intentionally simple: setup writes a snapshot, tests
// read it. There is no in-process engine handle exposed across the
// vitest globalSetup boundary because vitest forks workers — handles
// don't survive the boundary anyway.

export interface SetupOptions {
	/** Path to devstack.config.ts. Default: walk upward from cwd. */
	configPath?: string;
	/** Per-stack name (default 'test' — distinct from `up`'s default
	 * 'main' so a long-running supervisor and the test suite don't
	 * collide on the same snapshot file). */
	stack?: string;
	/** Network. Default 'localnet'. */
	network?: string;
	/** Override cwd discovery. Default process.cwd(). */
	cwd?: string;
}

export interface SetupHandle {
	engine: Engine;
	env: Env;
	configPath: string;
	cycle: CycleResult;
	snapshotPath: string;
}

// Programmatic entry. Call from a vitest globalSetup file:
//
//   // myapp/test/devstack.setup.ts
//   import { setupForTest, teardownForTest } from '@mysten-incubation/devstack-next/vitest';
//   let handle;
//   export async function setup() { handle = await setupForTest({ stack: 'test' }); }
//   export async function teardown() { if (handle) await teardownForTest(handle); }
//
// Then in vitest.config.ts:
//
//   test: { globalSetup: ['./test/devstack.setup.ts'] }
export async function setupForTest(opts: SetupOptions = {}): Promise<SetupHandle> {
	const loaded = await loadConfigAndEnv({
		cwd: opts.cwd ?? process.cwd(),
		...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
		...(opts.network !== undefined ? { network: opts.network } : {}),
		stack: opts.stack ?? 'test',
	});
	return setupForTestWithConfig({ config: loaded.config, env: loaded.env, configPath: loaded.configPath });
}

// Lower-level entry that skips config discovery — useful for tests that
// already have a synthetic DevstackConfig in memory and just want to
// drive the engine.
export async function setupForTestWithConfig(opts: {
	config: DevstackConfig;
	env: Env;
	configPath?: string;
}): Promise<SetupHandle> {
	const initial = await tryReadSnapshot(opts.env);
	const engine = new Engine(opts.config, {
		env: opts.env,
		...(initial !== undefined ? { initialSnapshot: initial } : {}),
	});

	// Surface engine errors to stderr — globalSetup output goes to the
	// vitest terminal, and a silent failure here makes test debugging
	// painful. Successful cycles stay quiet.
	const detach = engine.subscribe((event) => {
		if (event.type === 'engine:error') {
			process.stderr.write(
				`devstack vitest: engine error${event.name !== undefined ? ` in ${event.name}` : ''}: ${event.error.message}\n`,
			);
		}
	});

	const cycle = await engine.runOnce();
	if (cycle.errored.length > 0) {
		// Don't tear down on error — let the caller decide, but propagate.
		const summary = cycle.errored.map((e) => `${e.name}: ${e.error.message}`).join('; ');
		detach();
		await engine.stop();
		throw new Error(`devstack vitest: setup cycle errored — ${summary}`);
	}

	const snapshot = await engine.saveSnapshot();
	const snapshotPath = await writeSnapshot(opts.env, snapshot);
	detach();

	return {
		engine,
		env: opts.env,
		...(opts.configPath !== undefined ? { configPath: opts.configPath } : { configPath: '' }),
		cycle,
		snapshotPath,
	};
}

export async function teardownForTest(handle: SetupHandle): Promise<void> {
	await handle.engine.stop();
}

// Read the on-disk snapshot for the current test stack. Returns
// `undefined` if no snapshot exists (e.g., setup hasn't run yet).
//
// Two call shapes:
//   - `readSnapshot()` / `readSnapshot({ stack, network, ... })` — walks
//     upward from cwd to find devstack.config.* and derives the snapshot
//     path. Use this from app-level tests.
//   - `readSnapshot(env)` — short-circuits discovery. Useful when the
//     caller already has an Env (e.g. from a SetupHandle).
export async function readSnapshot(
	optsOrEnv: SetupOptions | Env = {},
): Promise<SnapshotRecord | undefined> {
	if (isEnv(optsOrEnv)) return tryReadSnapshot(optsOrEnv);
	const { env } = await resolveEnvOnly({
		cwd: optsOrEnv.cwd ?? process.cwd(),
		...(optsOrEnv.configPath !== undefined ? { configPath: optsOrEnv.configPath } : {}),
		...(optsOrEnv.network !== undefined ? { network: optsOrEnv.network } : {}),
		stack: optsOrEnv.stack ?? 'test',
	});
	return tryReadSnapshot(env);
}

function isEnv(v: SetupOptions | Env): v is Env {
	return (
		typeof (v as Env).appName === 'string' &&
		typeof (v as Env).appDir === 'string' &&
		typeof (v as Env).network === 'string'
	);
}

// Type-safe accessor for a node's persisted state in the snapshot.
// Tests usually want one specific node's state shape rather than the
// whole map. Throws when the node isn't present so a typo at the call
// site surfaces immediately instead of as a downstream `undefined.x`.
export function getNodeState<T = unknown>(
	snapshot: SnapshotRecord,
	nodeName: string,
): T {
	const entry = snapshot.nodeStates[nodeName];
	if (entry === undefined) {
		const have = Object.keys(snapshot.nodeStates).join(', ');
		throw new Error(
			`devstack vitest: snapshot has no node '${nodeName}' (have: ${have || '<none>'})`,
		);
	}
	if (entry.state === undefined) {
		throw new Error(
			`devstack vitest: node '${nodeName}' is in the snapshot but has no state (status='${entry.error !== undefined ? 'errored' : 'idle'}')`,
		);
	}
	return entry.state as T;
}
