import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../engine/types.js';
import {
	acquireStackLock,
	inspectStackLock,
	stackLockPath,
	StackLockBusyError,
	withStackLock,
} from './lock.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-lock-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

function localEnv(stack?: string): Env {
	const env: Env = { appName: 'demo', appDir, network: 'localnet' };
	if (stack !== undefined) env.stack = stack;
	return env;
}

function liveEnv(network: string): Env {
	return { appName: 'demo', appDir, network };
}

describe('stackLockPath', () => {
	it('uses per-stack supervisor.pid on localnet', () => {
		const env = localEnv('main');
		expect(stackLockPath(env)).toBe(
			join(appDir, '.devstack', 'stacks', 'main', 'supervisor.pid'),
		);
	});

	it('defaults to stack=main when env.stack is undefined', () => {
		expect(stackLockPath(localEnv())).toBe(
			join(appDir, '.devstack', 'stacks', 'main', 'supervisor.pid'),
		);
	});

	it('uses per-network .lock for live nets', () => {
		expect(stackLockPath(liveEnv('testnet'))).toBe(
			join(appDir, '.devstack', 'networks', 'testnet.lock'),
		);
	});
});

describe('acquireStackLock', () => {
	it('writes a lock file with pid + startedAt + acquiredAt', async () => {
		const env = localEnv();
		const handle = await acquireStackLock(env);
		try {
			expect(handle.path).toBe(stackLockPath(env));
			const raw = JSON.parse(await readFile(handle.path, 'utf8'));
			expect(raw.pid).toBe(process.pid);
			expect(typeof raw.startedAt).toBe('string');
			expect(typeof raw.acquiredAt).toBe('string');
		} finally {
			await handle.release();
		}
	});

	it('release() removes the lock file', async () => {
		const env = localEnv();
		const handle = await acquireStackLock(env);
		await handle.release();
		await expect(readFile(handle.path, 'utf8')).rejects.toThrow(/ENOENT/);
	});

	it('release() is idempotent (double-release does not throw)', async () => {
		const handle = await acquireStackLock(localEnv());
		await handle.release();
		await expect(handle.release()).resolves.toBeUndefined();
	});

	it('throws StackLockBusyError when a live holder exists (current process)', async () => {
		const env = localEnv();
		const a = await acquireStackLock(env);
		try {
			let caught: unknown;
			try {
				await acquireStackLock(env);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(StackLockBusyError);
			const busy = caught as StackLockBusyError;
			expect(busy.holderPid).toBe(process.pid);
			expect(busy.path).toBe(stackLockPath(env));
			// Message must be actionable — name a PID and the path to remove.
			expect(busy.message).toContain(String(process.pid));
			expect(busy.message).toContain(stackLockPath(env));
		} finally {
			await a.release();
		}
	});

	it('replaces a stale lock file whose recorded PID is dead', async () => {
		const env = localEnv();
		const path = stackLockPath(env);
		// Seed a stale file pointing at a PID that is almost certainly dead.
		// `0xfffff` is well above the typical PID range and unlikely to be
		// alive; if it is, the test is environmentally noisy and that's OK
		// because the lock will (correctly) be detected as live.
		await import('node:fs/promises').then((m) =>
			m.mkdir(join(appDir, '.devstack', 'stacks', 'main'), { recursive: true }),
		);
		await writeFile(
			path,
			JSON.stringify({
				pid: 0xfffff,
				startedAt: 'Mon Jan  1 00:00:00 2001',
				acquiredAt: '2001-01-01T00:00:00.000Z',
				host: 'ancient-host',
			}),
		);
		const handle = await acquireStackLock(env);
		try {
			const raw = JSON.parse(await readFile(handle.path, 'utf8'));
			expect(raw.pid).toBe(process.pid);
		} finally {
			await handle.release();
		}
	});

	it('replaces a stale lock file whose recorded startedAt mismatches the live PID (PID reuse)', async () => {
		const env = localEnv();
		const path = stackLockPath(env);
		await import('node:fs/promises').then((m) =>
			m.mkdir(join(appDir, '.devstack', 'stacks', 'main'), { recursive: true }),
		);
		// PID 1 (init) is always alive, but its start time is the boot
		// time — definitely not the contrived value below. So this is a
		// stale lock from a process that was PID 1 in a different boot
		// epoch (or, more realistically, PID reuse after a crash).
		await writeFile(
			path,
			JSON.stringify({
				pid: 1,
				startedAt: 'IMPOSSIBLE START TIME 9999',
				acquiredAt: '2001-01-01T00:00:00.000Z',
				host: 'stale-host',
			}),
		);
		const handle = await acquireStackLock(env);
		try {
			const raw = JSON.parse(await readFile(handle.path, 'utf8'));
			expect(raw.pid).toBe(process.pid);
		} finally {
			await handle.release();
		}
	});

	it('replaces an unparseable lock file', async () => {
		const env = localEnv();
		const path = stackLockPath(env);
		await import('node:fs/promises').then((m) =>
			m.mkdir(join(appDir, '.devstack', 'stacks', 'main'), { recursive: true }),
		);
		await writeFile(path, 'this is not json{{{');
		const handle = await acquireStackLock(env);
		try {
			const raw = JSON.parse(await readFile(handle.path, 'utf8'));
			expect(raw.pid).toBe(process.pid);
		} finally {
			await handle.release();
		}
	});

	it('different stacks under the same app do not collide', async () => {
		const a = await acquireStackLock(localEnv('main'));
		const b = await acquireStackLock(localEnv('test'));
		try {
			expect(a.path).not.toBe(b.path);
		} finally {
			await a.release();
			await b.release();
		}
	});

	it('localnet and live-net lock paths under the same appDir do not collide', async () => {
		const a = await acquireStackLock(localEnv());
		const b = await acquireStackLock(liveEnv('testnet'));
		try {
			expect(a.path).not.toBe(b.path);
		} finally {
			await a.release();
			await b.release();
		}
	});
});

describe('inspectStackLock', () => {
	it('returns null when no lock file exists', async () => {
		await expect(inspectStackLock(localEnv())).resolves.toBeNull();
	});

	it('reports alive=true when the recorded holder is the current process', async () => {
		const handle = await acquireStackLock(localEnv());
		try {
			const info = await inspectStackLock(localEnv());
			expect(info?.pid).toBe(process.pid);
			expect(info?.alive).toBe(true);
		} finally {
			await handle.release();
		}
	});

	it('reports alive=false for a clearly-dead PID', async () => {
		const env = localEnv();
		const path = stackLockPath(env);
		await import('node:fs/promises').then((m) =>
			m.mkdir(join(appDir, '.devstack', 'stacks', 'main'), { recursive: true }),
		);
		await writeFile(
			path,
			JSON.stringify({
				pid: 0xfffff,
				startedAt: 'never',
				acquiredAt: '2001-01-01T00:00:00.000Z',
				host: 'gone',
			}),
		);
		const info = await inspectStackLock(env);
		expect(info?.pid).toBe(0xfffff);
		expect(info?.alive).toBe(false);
	});
});

describe('withStackLock', () => {
	it('acquires, runs fn, and releases', async () => {
		const env = localEnv();
		let observed = '';
		const result = await withStackLock(env, async () => {
			observed = await readFile(stackLockPath(env), 'utf8');
			return 42;
		});
		expect(result).toBe(42);
		expect(observed).toContain(String(process.pid));
		// Released after fn returns.
		await expect(readFile(stackLockPath(env), 'utf8')).rejects.toThrow(/ENOENT/);
	});

	it('releases the lock even when fn throws', async () => {
		const env = localEnv();
		await expect(
			withStackLock(env, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow(/boom/);
		await expect(readFile(stackLockPath(env), 'utf8')).rejects.toThrow(/ENOENT/);
	});

	it('propagates StackLockBusyError when the stack is held by another caller', async () => {
		const env = localEnv();
		const outer = await acquireStackLock(env);
		try {
			await expect(withStackLock(env, async () => 'ok')).rejects.toBeInstanceOf(
				StackLockBusyError,
			);
		} finally {
			await outer.release();
		}
	});
});
