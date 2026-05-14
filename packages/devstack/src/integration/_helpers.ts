import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import type { Env } from '../engine/types.js';

// Shared scaffolding for `src/integration/**` end-to-end tests.
//
// Each test file describes a real bring-up (sui + walrus committee +
// seal key-server, etc.) under `itIntegration` / `describeIntegration`,
// which skip when:
//   - Docker isn't reachable (matches the `itDocker` gate in unit
//     tests), AND/OR
//   - The test is tagged `slow` and `RUN_SLOW_INTEGRATION` isn't set.
//
// Test bodies receive a fresh `tmpdir` appDir and a tracked-resources
// helper so containers / networks / images don't leak between runs:
//
//   itIntegration('boots sui localnet', async ({ env, track }) => {
//       const engine = new Engine({ stack: [sui.create({ network: 'localnet' })] }, { env });
//       await engine.runOnce();
//       const state = engine.getState().nodes.get('sui.localnet.container')?.state;
//       track.container(state.containerId);
//       ...
//       await engine.stop();
//   });
//
// `track.network(name)` / `track.image(tag)` queue best-effort cleanup
// in afterEach. Cleanup keeps test runs hermetic — the next test sees
// a clean docker environment regardless of how the prior one exited.

const dockerAvailable = (() => {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

export interface Tracker {
	/** Track a container ID (or name) for `docker rm -f` after the test. */
	container(id: string | undefined): void;
	/** Track a network name for `docker network rm` after the test. */
	network(name: string | undefined): void;
	/** Track an image tag for `docker image rm -f` after the test. By
	 * default integration tests skip image cleanup so caches stay warm
	 * across runs — pass an explicit tag here only when you want it
	 * removed (e.g. testing a `dockerImage` rebuild that produces
	 * single-use tags). */
	image(tag: string | undefined): void;
}

export interface IntegrationTestArgs {
	env: Env;
	appDir: string;
	track: Tracker;
}

interface TestContext {
	containers: Set<string>;
	networks: Set<string>;
	images: Set<string>;
}

function makeContext(): TestContext {
	return { containers: new Set(), networks: new Set(), images: new Set() };
}

function makeTracker(ctx: TestContext): Tracker {
	return {
		container: (id) => {
			if (id !== undefined) ctx.containers.add(id);
		},
		network: (name) => {
			if (name !== undefined) ctx.networks.add(name);
		},
		image: (tag) => {
			if (tag !== undefined) ctx.images.add(tag);
		},
	};
}

function cleanupContext(ctx: TestContext): void {
	for (const id of ctx.containers) {
		try {
			execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
		} catch {
			// best-effort
		}
	}
	for (const name of ctx.networks) {
		try {
			execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
		} catch {
			// best-effort
		}
	}
	for (const tag of ctx.images) {
		try {
			execFileSync('docker', ['image', 'rm', '-f', tag], { stdio: 'ignore' });
		} catch {
			// best-effort
		}
	}
}

export interface IntegrationTestOptions {
	/** Test timeout override in ms. Default falls through to the
	 * vitest config's testTimeout (10 minutes). */
	timeout?: number;
	/** Slow tests gate on `RUN_SLOW_INTEGRATION=1` in addition to the
	 * docker check. Use for >5-minute first-time setups (walrus
	 * upstream image cargo-compile). */
	slow?: boolean;
}

const slowGate = process.env.RUN_SLOW_INTEGRATION === '1';

/** Per-test fixture wrapper. Builds an `Env` rooted in a fresh
 * tmpdir, runs the test body, then cleans tracked containers /
 * networks / images. Skips when docker isn't available or when
 * `opts.slow` is set without `RUN_SLOW_INTEGRATION=1`. */
export function itIntegration(
	name: string,
	body: (args: IntegrationTestArgs) => Promise<void>,
	opts: IntegrationTestOptions = {},
): void {
	const skip = !dockerAvailable || (opts.slow === true && !slowGate);
	const reason = !dockerAvailable
		? 'docker unavailable'
		: opts.slow === true && !slowGate
			? 'set RUN_SLOW_INTEGRATION=1 to run'
			: '';

	let appDir: string;
	let env: Env;
	let ctx: TestContext;

	beforeEach(() => {
		appDir = mkdtempSync(join(tmpdir(), 'devstack-int-'));
		env = {
			appName: `int-${Math.random().toString(36).slice(2, 8)}`,
			appDir,
			network: 'localnet',
			stack: 'main',
		};
		ctx = makeContext();
	});

	afterEach(() => {
		cleanupContext(ctx);
		rmSync(appDir, { recursive: true, force: true });
	});

	const fn = async () => {
		await body({ env, appDir, track: makeTracker(ctx) });
	};

	if (skip) {
		it.skip(`${name} (${reason})`, fn);
	} else if (opts.timeout !== undefined) {
		it(name, fn, opts.timeout);
	} else {
		it(name, fn);
	}
}

/** Sugar for `describe` so test files can read top-down without
 * naming a describe block by hand. Skips the entire block when
 * docker isn't available. */
export function describeIntegration(name: string, body: () => void): void {
	if (!dockerAvailable) {
		describe.skip(`${name} (docker unavailable)`, body);
	} else {
		describe(name, body);
	}
}

export const isDockerAvailable = (): boolean => dockerAvailable;
export const isSlowIntegrationEnabled = (): boolean => slowGate;
