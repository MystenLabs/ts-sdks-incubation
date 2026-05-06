// Supervisor-lock tests. Pin the cross-process safety invariant of PR
// A8: a second `devstack up` against an already-active stack fails
// loudly instead of silently fighting the running supervisor over
// container names + manifest writes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	SupervisorLockBusyError,
	acquireSupervisorLock,
	inspectSupervisorLock,
	lockfilePath,
	writeStaleLockForTesting,
} from './supervisor-lock.js';
import { stackDir } from './active-stack.js';

let appDirs: string[] = [];

function newAppDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-lock-'));
	appDirs.push(dir);
	return dir;
}

beforeEach(() => {
	appDirs = [];
});

afterEach(() => {
	for (const d of appDirs) rmSync(d, { recursive: true, force: true });
});

describe('lockfilePath', () => {
	it('is per-(app, stack) under the stack dir', () => {
		const appDir = newAppDir();
		const path = lockfilePath({ appDir, stack: 'main' });
		expect(path).toBe(join(stackDir(appDir, 'main'), 'supervisor.pid'));
	});
});

describe('inspectSupervisorLock', () => {
	it('returns null when no lockfile exists', () => {
		const appDir = newAppDir();
		expect(inspectSupervisorLock({ appDir, stack: 'main' })).toBeNull();
	});

	it('reports alive=true when the recorded PID is the current process', () => {
		const appDir = newAppDir();
		writeStaleLockForTesting({ appDir, stack: 'main' }, process.pid);
		const state = inspectSupervisorLock({ appDir, stack: 'main' });
		expect(state).toEqual({ pid: process.pid, alive: true });
	});

	it('reports alive=false when the recorded PID is dead', () => {
		const appDir = newAppDir();
		// PID 1 exists on Linux/macOS but isn't us; use a clearly-dead PID.
		// 2^31-1 is well above any real PID range and ensures ESRCH.
		writeStaleLockForTesting({ appDir, stack: 'main' }, 2147483646);
		const state = inspectSupervisorLock({ appDir, stack: 'main' });
		expect(state?.alive).toBe(false);
	});

	it('treats corrupt lockfile contents as alive=false (replaceable)', () => {
		const appDir = newAppDir();
		const path = lockfilePath({ appDir, stack: 'main' });
		// Write the lockfile via writeStaleLockForTesting first to make
		// the dir exist, then overwrite with garbage.
		writeStaleLockForTesting({ appDir, stack: 'main' }, 1);
		writeFileSync(path, 'not a number\n');
		const state = inspectSupervisorLock({ appDir, stack: 'main' });
		expect(state?.alive).toBe(false);
	});
});

describe('acquireSupervisorLock', () => {
	it('writes the current PID into the lockfile and returns a release handle', async () => {
		const appDir = newAppDir();
		const handle = await acquireSupervisorLock({ appDir, stack: 'main' });
		expect(handle.pid).toBe(process.pid);
		expect(existsSync(handle.path)).toBe(true);
		const parsed = JSON.parse(readFileSync(handle.path, 'utf8')) as { pid: number };
		expect(parsed.pid).toBe(process.pid);
		handle.release();
	});

	it('throws SupervisorLockBusyError when an alive PID owns the lock', async () => {
		const appDir = newAppDir();
		// Pretend another live process holds it (we cheat by using our own pid).
		writeStaleLockForTesting({ appDir, stack: 'main' }, process.pid);
		await expect(acquireSupervisorLock({ appDir, stack: 'main' })).rejects.toBeInstanceOf(
			SupervisorLockBusyError,
		);
	});

	it('replaces a stale lockfile (dead PID)', async () => {
		const appDir = newAppDir();
		writeStaleLockForTesting({ appDir, stack: 'main' }, 2147483646);
		const handle = await acquireSupervisorLock({ appDir, stack: 'main' });
		expect(handle.pid).toBe(process.pid);
		const parsed = JSON.parse(readFileSync(handle.path, 'utf8')) as { pid: number };
		expect(parsed.pid).toBe(process.pid);
		handle.release();
	});

	it('release() removes the lockfile', async () => {
		const appDir = newAppDir();
		const handle = await acquireSupervisorLock({ appDir, stack: 'main' });
		expect(existsSync(handle.path)).toBe(true);
		handle.release();
		expect(existsSync(handle.path)).toBe(false);
	});

	it('release() is idempotent', async () => {
		const appDir = newAppDir();
		const handle = await acquireSupervisorLock({ appDir, stack: 'main' });
		handle.release();
		handle.release();
		expect(existsSync(handle.path)).toBe(false);
	});

	it('release() does NOT remove a lockfile owned by a different PID', async () => {
		const appDir = newAppDir();
		const handle = await acquireSupervisorLock({ appDir, stack: 'main' });
		// Simulate another supervisor stomping on our PID file (shouldn't
		// happen in practice, but the guard protects against it).
		writeFileSync(handle.path, '99999\n');
		handle.release();
		expect(existsSync(handle.path)).toBe(true);
	});

	it('per-stack scoping: different stacks acquire independently', async () => {
		const appDir = newAppDir();
		const lockMain = await acquireSupervisorLock({ appDir, stack: 'main' });
		const lockTest = await acquireSupervisorLock({ appDir, stack: 'test' });
		expect(lockMain.path).not.toBe(lockTest.path);
		lockMain.release();
		lockTest.release();
	});

	it('SupervisorLockBusyError carries the offending PID + path', async () => {
		const appDir = newAppDir();
		writeStaleLockForTesting({ appDir, stack: 'main' }, process.pid);
		try {
			await acquireSupervisorLock({ appDir, stack: 'main' });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SupervisorLockBusyError);
			const e = err as SupervisorLockBusyError;
			expect(e.state.pid).toBe(process.pid);
			expect(e.path).toMatch(/supervisor\.pid$/);
		}
	});
});
