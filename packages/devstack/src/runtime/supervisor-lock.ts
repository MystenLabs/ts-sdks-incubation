// Supervisor lockfile. Prevents two `devstack up` invocations from
// fighting over the same (app, stack) — they'd race on container
// names, manifest writes, port-allocator persistence, and the active-
// stack pointer. The second invocation gets a clear error pointing at
// the running one's PID.
//
// File: `<appDir>/.devstack/stacks/<stack>/supervisor.pid` (per-stack
// so two stacks of the same app can coexist on disk; only one can be
// "up" at a time, but the lockfile is scoped accordingly).
//
// Acquisition uses `O_EXCL` for atomicity. If the file exists, we
// check whether the recorded PID is still alive via `process.kill(pid,
// 0)`; a dead PID means a prior supervisor crashed and the file is
// stale — we replace it. A live PID is treated as "another supervisor
// owns this stack" and acquisition fails.
//
// `cli/stack use` consults the same file: switching active stacks
// while a supervisor is running on the previous stack would cause it
// to resurrect containers in a tight loop. Better to refuse with a
// clear hint.

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { close, write } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { stackDir } from './active-stack.js';

const writeAsync = promisify(write);
const closeAsync = promisify(close);

export interface SupervisorLockOptions {
	appDir: string;
	stack: string;
}

export interface SupervisorLockHandle {
	/** Filesystem path of the lockfile. */
	path: string;
	/** PID recorded in the lockfile. */
	pid: number;
	/** Release the lock. Idempotent — calling twice is safe. */
	release: () => void;
}

/** Returned by `inspectSupervisorLock` when an existing lockfile is
 * found. The caller decides whether to replace (dead PID) or refuse
 * (live PID). */
export interface SupervisorLockState {
	pid: number;
	alive: boolean;
}

export class SupervisorLockBusyError extends Error {
	constructor(
		readonly state: SupervisorLockState,
		readonly path: string,
	) {
		super(
			`supervisor lock at ${path} is held by PID ${state.pid} ` +
				'(another `devstack up` is running for this stack). ' +
				'Stop it (Ctrl-C in its terminal, or kill the PID) before ' +
				'starting a new one.',
		);
		this.name = 'SupervisorLockBusyError';
	}
}

export function lockfilePath(opts: SupervisorLockOptions): string {
	return `${stackDir(opts.appDir, opts.stack)}/supervisor.pid`;
}

/** Read the current lockfile (if any) and report whether the PID is
 * alive. Returns `null` when no lockfile exists. */
export function inspectSupervisorLock(opts: SupervisorLockOptions): SupervisorLockState | null {
	const path = lockfilePath(opts);
	if (!existsSync(path)) return null;
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
	} catch {
		// Corrupt lockfile — treat as stale and let the acquirer replace it.
		return { pid: 0, alive: false };
	}
	if (!Number.isFinite(pid) || pid <= 0) {
		return { pid: 0, alive: false };
	}
	return { pid, alive: pidAlive(pid) };
}

/** Acquire the supervisor lock for this (app, stack). Throws
 * `SupervisorLockBusyError` when the lockfile is held by a live PID;
 * silently replaces stale lockfiles. */
export async function acquireSupervisorLock(
	opts: SupervisorLockOptions,
): Promise<SupervisorLockHandle> {
	const path = lockfilePath(opts);
	mkdirSync(dirname(path), { recursive: true });
	const myPid = process.pid;

	// Pre-check: replace stale lockfile so the O_EXCL open below
	// succeeds. Pre-check is racy if two processes pass it
	// simultaneously — that's what O_EXCL guards.
	const existing = inspectSupervisorLock(opts);
	if (existing !== null && !existing.alive) {
		try {
			unlinkSync(path);
		} catch {
			// Lost the race to another process clearing the same stale
			// lockfile — fall through; the O_EXCL below either succeeds
			// (we won) or fails with EEXIST (other process wrote first).
		}
	}

	let fd: number;
	try {
		// O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if the file
		// exists. That's the atomic acquisition. 0o600 so the PID file
		// isn't world-readable on shared dev hosts.
		fd = openSync(path, 'wx', 0o600);
	} catch (err) {
		if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
			const state = inspectSupervisorLock(opts);
			throw new SupervisorLockBusyError(
				state ?? { pid: 0, alive: false },
				path,
			);
		}
		throw err;
	}
	await writeAsync(fd, `${myPid}\n`, null, 'utf8');
	await closeAsync(fd);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			// Only delete if the file still records OUR pid — protects
			// against the rare case where our process clock skewed and
			// another supervisor adopted an older lock.
			const observed = readFileSync(path, 'utf8').trim();
			if (observed === String(myPid)) {
				unlinkSync(path);
			}
		} catch {
			// Already gone — fine.
		}
	};

	return { path, pid: myPid, release };
}

/** True if `process.kill(pid, 0)` succeeds — the process exists and we
 * can signal it. False on ESRCH (no such process). EPERM (process
 * exists but we can't signal it) is treated as alive: the supervisor
 * is running, just under a different uid. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (err instanceof Error && 'code' in err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'EPERM') return true;
			if (code === 'ESRCH') return false;
		}
		return false;
	}
}

/** Sync helper for legacy callers (the supervisor uses the async form;
 * `cli/stack` reads the lock state via this). */
export function writeStaleLockForTesting(opts: SupervisorLockOptions, pid: number): string {
	const path = lockfilePath(opts);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${pid}\n`, 'utf8');
	return path;
}
