import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { hostProcess, type HostProcessState } from './host-process.js';

let appDir: string;
let env: { appName: string; appDir: string; network: string };

beforeEach(() => {
	appDir = mkdtempSync(join(tmpdir(), 'host-process-'));
	env = { appName: 'test', appDir, network: 'localnet' };
});

const trackedPids = new Set<number>();

afterEach(() => {
	for (const pid of trackedPids) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}
	trackedPids.clear();
	rmSync(appDir, { recursive: true, force: true });
});

function trackPid(pid: number | undefined): void {
	if (pid !== undefined) trackedPids.add(pid);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('hostProcess', () => {
	it('spawns a subprocess and captures pid + command into state', async () => {
		const node = hostProcess({
			name: 'sleeper',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		});

		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();

		const view = engine.getState().nodes.get('sleeper');
		const state = view?.state as HostProcessState | undefined;
		expect(state).toBeDefined();
		expect(state?.pid).toBeGreaterThan(0);
		expect(state?.command).toBe(process.execPath);
		trackPid(state?.pid);

		await engine.stop();
		expect(state ? isAlive(state.pid) : false).toBe(false);
	});

	it('reuses prior pid on warm restart if process is still alive', async () => {
		const node = hostProcess({
			name: 'reuse',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		});

		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const firstPid = (engine.getState().nodes.get('reuse')?.state as HostProcessState).pid;
		trackPid(firstPid);

		// Force re-evaluation; start should re-attach to the same pid.
		engine.invalidate('reuse');
		await engine.runOnce();
		const secondPid = (engine.getState().nodes.get('reuse')?.state as HostProcessState).pid;

		expect(secondPid).toBe(firstPid);

		await engine.stop();
	});

	it('respawns when command/args change between cycles (snapshot mismatch)', async () => {
		const snapshot = {
			createdAt: Date.now(),
			env: { appName: 'test', network: 'localnet' },
			nodeStates: {
				stale: {
					state: {
						pid: 99999, // a likely-dead pid
						startedAt: Date.now() - 60_000,
						command: process.execPath,
						args: ['-e', 'old'],
					},
					lastInputHash: 'old',
					lastRunAt: Date.now() - 60_000,
				},
			},
			meta: { devstackVersion: 'test' },
		};

		const node = hostProcess({
			name: 'stale',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		});

		const engine = new Engine({ stack: [node] }, { env, initialSnapshot: snapshot });
		await engine.runOnce();

		const newPid = (engine.getState().nodes.get('stale')?.state as HostProcessState).pid;
		trackPid(newPid);
		expect(newPid).not.toBe(99999);

		await engine.stop();
	});

	it('respects a readyProbe — start does not return until probe yields true', async () => {
		const startedAt = Date.now();
		let probeCalls = 0;
		const node = hostProcess({
			name: 'probed',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
			readyProbe: () => {
				probeCalls += 1;
				return probeCalls >= 3;
			},
			readyPollIntervalMs: 50,
		});

		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const elapsed = Date.now() - startedAt;
		const state = engine.getState().nodes.get('probed')?.state as HostProcessState | undefined;
		trackPid(state?.pid);

		expect(probeCalls).toBeGreaterThanOrEqual(3);
		expect(elapsed).toBeGreaterThanOrEqual(100); // 2 polls × 50ms minimum

		await engine.stop();
	});

	it('errors and kills the child when readyProbe times out', async () => {
		const node = hostProcess({
			name: 'never-ready',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
			readyProbe: () => false,
			readyTimeoutMs: 100,
			readyPollIntervalMs: 25,
		});

		const engine = new Engine({ stack: [node] }, { env });
		const result = await engine.runOnce();

		const errored = result.errored.find((e) => e.name === 'never-ready');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/readyProbe did not return true/);

		await engine.stop();
	});

	it('forwards stdout/stderr lines to the engine log channel', async () => {
		const node = hostProcess({
			name: 'echoer',
			command: process.execPath,
			args: ['-e', 'console.log("HELLO_FROM_CHILD"); setTimeout(() => {}, 1000)'],
		});

		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();

		// Give the OS a moment to drain stdout into the parent.
		await new Promise((r) => setTimeout(r, 200));

		const view = engine.getState().nodes.get('echoer');
		trackPid((view?.state as HostProcessState | undefined)?.pid);
		expect(view?.logs.some((l) => l.includes('HELLO_FROM_CHILD'))).toBe(true);

		await engine.stop();
	});
});
