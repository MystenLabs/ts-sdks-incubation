import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Env } from '../engine/types.js';

const exec = promisify(execFile);

// Single exclusive lock per stack realpath. One mutating CLI invocation
// at a time per stack; harnesses (vitest globalSetup, playwright per-worker
// stack) are structured so contention doesn't arise — see plan §3.7.
//
// On localnet the lock lives at `<appDir>/.devstack/stacks/<stack>/supervisor.pid`
// — the same dir snapshots and runtime state already use. On live nets the
// stack dimension doesn't apply, so the lock sits at
// `<appDir>/.devstack/networks/<network>.lock`.

export function stackLockPath(env: Env): string {
	if (env.network === 'localnet') {
		return join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main', 'supervisor.pid');
	}
	return join(env.appDir, '.devstack', 'networks', `${env.network}.lock`);
}

export class StackLockBusyError extends Error {
	public readonly holderPid: number;
	public readonly holderStartedAt: string | undefined;
	public readonly path: string;

	constructor(args: { holderPid: number; holderStartedAt?: string; path: string }) {
		const startedTag = args.holderStartedAt ? ` (started ${args.holderStartedAt})` : '';
		super(
			`devstack stack is locked by pid ${args.holderPid}${startedTag}. ` +
				`If you're sure that process is dead, remove ${args.path} and retry.`,
		);
		this.name = 'StackLockBusyError';
		this.holderPid = args.holderPid;
		if (args.holderStartedAt !== undefined) this.holderStartedAt = args.holderStartedAt;
		this.path = args.path;
	}
}

export interface StackLockHandle {
	path: string;
	release(): Promise<void>;
}

interface LockFileContents {
	pid: number;
	startedAt: string;
	acquiredAt: string;
	host: string;
}

// PID-reuse defense: read `ps -o lstart=` for the recorded PID. If the
// process is alive AND its start time matches what we wrote, the lock
// is held. If the PID is gone or the start time differs (PID was
// reused after a crash), the lock is stale.
async function processStartTime(pid: number): Promise<string | undefined> {
	try {
		const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
			timeout: 2000,
		});
		const trimmed = stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

async function readLockFile(path: string): Promise<LockFileContents | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<LockFileContents>;
		if (typeof parsed.pid !== 'number') return undefined;
		return {
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
			acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
			host: typeof parsed.host === 'string' ? parsed.host : '',
		};
	} catch {
		return undefined;
	}
}

async function isHolderLive(holder: LockFileContents): Promise<boolean> {
	const live = await processStartTime(holder.pid);
	if (live === undefined) return false;
	// Old lock files (or platforms where `ps -o lstart=` returned empty
	// on write) carry an empty startedAt. Treat presence-of-PID as
	// authoritative in that case so we don't break out from under
	// ourselves; new locks will always have a non-empty startedAt.
	if (holder.startedAt === '') return true;
	return live === holder.startedAt;
}

export async function inspectStackLock(env: Env): Promise<{ pid: number; alive: boolean } | null> {
	const path = stackLockPath(env);
	const holder = await readLockFile(path);
	if (!holder) return null;
	return { pid: holder.pid, alive: await isHolderLive(holder) };
}

async function tryAtomicCreate(path: string, body: string): Promise<boolean> {
	try {
		// `wx` = open with O_WRONLY|O_CREAT|O_EXCL — atomic; fails with
		// EEXIST if the path is already present. This is what keeps two
		// concurrent acquirers from both succeeding on a read-then-write
		// race.
		await writeFile(path, body, { flag: 'wx', encoding: 'utf8' });
		return true;
	} catch (err) {
		if ((err as { code?: string }).code === 'EEXIST') return false;
		throw err;
	}
}

export async function acquireStackLock(env: Env): Promise<StackLockHandle> {
	const path = stackLockPath(env);
	await mkdir(dirname(path), { recursive: true });

	const startedAt = (await processStartTime(process.pid)) ?? '';
	const contents: LockFileContents = {
		pid: process.pid,
		startedAt,
		acquiredAt: new Date().toISOString(),
		host: hostname(),
	};
	const body = `${JSON.stringify(contents, null, 2)}\n`;

	// Fast path: file doesn't exist — atomic create wins.
	if (await tryAtomicCreate(path, body)) {
		return makeHandle(path, contents);
	}

	// File exists. Either a live holder or a stale lock left behind.
	const existing = await readLockFile(path);
	if (existing && (await isHolderLive(existing))) {
		throw new StackLockBusyError({
			holderPid: existing.pid,
			...(existing.startedAt ? { holderStartedAt: existing.startedAt } : {}),
			path,
		});
	}

	// Stale (dead PID, mismatched start time, or unparseable). Try to
	// claim it: unlink + atomic-create. If another process beats us
	// here, surface their lock — not our own.
	try {
		await unlink(path);
	} catch {
		// Already gone (someone else's cleanup raced us).
	}
	if (await tryAtomicCreate(path, body)) {
		return makeHandle(path, contents);
	}
	const winner = await readLockFile(path);
	throw new StackLockBusyError({
		holderPid: winner?.pid ?? -1,
		...(winner?.startedAt ? { holderStartedAt: winner.startedAt } : {}),
		path,
	});
}

function makeHandle(path: string, contents: LockFileContents): StackLockHandle {
	let released = false;
	return {
		path,
		release: async () => {
			if (released) return;
			released = true;
			// Only delete if we still own the file (defensive — another
			// process may have detected ours as stale and overwritten it).
			const current = await readLockFile(path);
			if (current?.pid === contents.pid && current?.acquiredAt === contents.acquiredAt) {
				try {
					await unlink(path);
				} catch {
					// already gone
				}
			}
		},
	};
}

// Wrap a mutating operation in lock acquisition + release. Re-throws
// from `fn` after releasing; re-throws `StackLockBusyError` from
// acquire (no silent retries — the caller decides whether to wait).
export async function withStackLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
	const handle = await acquireStackLock(env);
	try {
		return await fn();
	} finally {
		await handle.release();
	}
}
