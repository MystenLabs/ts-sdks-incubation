// Stale-lock detection + cleanup for both the state-store
// (`<root>/.devstack/**/*.lock`) and the per-build-dep
// (`~/.move/git/<repo>/.git/*.lock`) tracks.
//
// Doctor REPORTS by default; mutation is gated on the shared
// `--clean-locks` flag in the action. Both flavours surface here so
// the doctor sees the same lock state the engine acts on at build
// time (the engine's `withMoveBuildLock` sweeps the move-git locks
// itself; doctor mirrors the read so an operator can audit without
// booting the engine).

import { Effect, FileSystem } from 'effect';
import * as nodeFsSync from 'node:fs';
import * as nodePath from 'node:path';
import { join as joinPath } from 'node:path';
import { sweepStaleGitLocks } from '../../../engine/move-build-lock.js';
import { isHolderLive } from '../../../engine/process-liveness.js';
import type { Check } from './_check.js';

// ---------------------------------------------------------------------------
// State-store locks (`<root>/.devstack/**/*.lock`)
// ---------------------------------------------------------------------------

// Find every `*.lock` file under `<root>/.devstack/` whose holder pid is
// dead and remove it. Stale locks are orphans: the supervisor that
// wrote them is gone, but its `state.json.lock` was never deleted
// (e.g. SIGKILL skipped the scope finalizer, the machine power-cycled,
// or a Docker Desktop hang killed the host process). Without cleanup,
// the next `pnpm dev` for that stack fails with a misleading
// "stack 'main' is already running (pid <dead>)" message.
//
// We only consider `<root>/.devstack/` — explicitly NOT
// `~/.devstack/` — because:
//   1. Per-repo locks live here; the global registry doesn't carry
//      O_EXCL lock files.
//   2. Walking the user's home for `*.lock` overreaches doctor's
//      scope ("preflight for THIS app").
//
// `DEVSTACK_APP_DIR` env override is honored to mirror the rest of
// the toolchain.
export interface StaleLock {
	readonly path: string;
	readonly pid: number | undefined;
	readonly startedAt: string;
	readonly host: string;
	/** Parsed `acquiredAt` ISO string, when available. Surfaces in the
	 *  detail line so the user can correlate against e.g. their last
	 *  laptop restart. */
	readonly acquiredAt: string | undefined;
}

const isLockFile = (name: string): boolean => name === 'state.json.lock' || name.endsWith('.lock');

// Walk one directory looking for `*.lock` files. Returns them as
// absolute paths. Non-recursive — locks live one directory deep
// (`.devstack/stacks/<stack>/state.json.lock`,
//  `.devstack/networks/<network>.lock`).
const listLockFiles = (
	fs: FileSystem.FileSystem,
	dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return [];
		const entries = yield* fs
			.readDirectory(dir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		const out: Array<string> = [];
		for (const entry of entries) {
			const full = joinPath(dir, entry);
			const stat = yield* fs.stat(full).pipe(
				Effect.map((s) => s.type),
				Effect.orElseSucceed(() => 'Unknown' as const),
			);
			if (stat === 'File' && isLockFile(entry)) out.push(full);
		}
		return out as ReadonlyArray<string>;
	});

const readLockBody = (
	fs: FileSystem.FileSystem,
	path: string,
): Effect.Effect<{
	pid: number | undefined;
	startedAt: string;
	host: string;
	acquiredAt: string | undefined;
}> =>
	Effect.gen(function* () {
		const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ''));
		if (text.trim().length === 0) {
			return { pid: undefined, startedAt: '', host: '', acquiredAt: undefined };
		}
		try {
			const parsed = JSON.parse(text) as {
				pid?: unknown;
				startedAt?: unknown;
				host?: unknown;
				acquiredAt?: unknown;
			};
			const pid =
				typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0
					? parsed.pid
					: undefined;
			const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : '';
			const host = typeof parsed.host === 'string' ? parsed.host : '';
			const acquiredAt = typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined;
			return { pid, startedAt, host, acquiredAt };
		} catch {
			return { pid: undefined, startedAt: '', host: '', acquiredAt: undefined };
		}
	});

export const findStaleLocks = (
	fs: FileSystem.FileSystem,
	devstackDir: string,
): Effect.Effect<ReadonlyArray<StaleLock>> =>
	Effect.gen(function* () {
		const candidates: Array<string> = [];
		// Per-stack localnet locks: `.devstack/stacks/<stack>/state.json.lock`.
		const stacksDir = joinPath(devstackDir, 'stacks');
		const stacksEntries = yield* fs
			.readDirectory(stacksDir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		for (const stack of stacksEntries) {
			const stackDir = joinPath(stacksDir, stack);
			const inner = yield* listLockFiles(fs, stackDir);
			for (const p of inner) candidates.push(p);
		}
		// Live-net locks: `.devstack/networks/<network>.lock`.
		const netsDir = joinPath(devstackDir, 'networks');
		const netLocks = yield* listLockFiles(fs, netsDir);
		for (const p of netLocks) candidates.push(p);

		const out: Array<StaleLock> = [];
		for (const path of candidates) {
			const body = yield* readLockBody(fs, path);
			// A lock is "stale" if the pid is missing/unreadable (the body
			// is corrupt — no holder to defer to) OR the pid+startedAt
			// pair fails the start-time-aware liveness check (defends
			// against PID-reuse — a reused pid that happens to be alive
			// but with a different start time should NOT be treated as
			// the original holder). Cross-host holders are conservatively
			// classified as live so we don't blow away a peer's lock on
			// a shared filesystem.
			const stale =
				body.pid === undefined ||
				!isHolderLive({ pid: body.pid, startedAt: body.startedAt, host: body.host });
			if (stale) {
				out.push({
					path,
					pid: body.pid,
					startedAt: body.startedAt,
					host: body.host,
					acquiredAt: body.acquiredAt,
				});
			}
		}
		return out as ReadonlyArray<StaleLock>;
	});

export const removeStaleLocks = (
	fs: FileSystem.FileSystem,
	locks: ReadonlyArray<StaleLock>,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		for (const lock of locks) {
			// Re-verify the holder is dead immediately before unlink. The
			// findStaleLocks pass and the unlink can race a supervisor
			// that just woke up and rewrote the lock body; checking again
			// here keeps the window between observation and mutation as
			// narrow as a single read.
			const body = yield* readLockBody(fs, lock.path);
			if (
				body.pid !== undefined &&
				isHolderLive({ pid: body.pid, startedAt: body.startedAt, host: body.host })
			) {
				continue;
			}
			const ok = yield* fs.remove(lock.path).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (ok) removed.push(lock.path);
		}
		return removed as ReadonlyArray<string>;
	});

export const stateStoreLockCheck = (args: {
	staleLocks: ReadonlyArray<StaleLock>;
	removedLocks: ReadonlyArray<string>;
	cleanLocks: boolean;
}): Check => {
	const { staleLocks, removedLocks, cleanLocks } = args;
	if (staleLocks.length === 0) {
		return { name: 'State-store locks', ok: true, required: false, detail: 'no stale locks' };
	}
	if (!cleanLocks) {
		return {
			name: 'State-store locks',
			ok: false,
			required: false,
			detail: `${staleLocks.length} stale lock${staleLocks.length === 1 ? '' : 's'} found — re-run with --clean-locks to remove`,
		};
	}
	const allRemoved = removedLocks.length === staleLocks.length;
	return {
		name: 'State-store locks',
		ok: allRemoved,
		required: false,
		detail: allRemoved
			? `removed ${removedLocks.length} stale lock${removedLocks.length === 1 ? '' : 's'}`
			: `removed ${removedLocks.length}/${staleLocks.length} stale lock${staleLocks.length === 1 ? '' : 's'} (rest still held or filesystem error)`,
	};
};

// ---------------------------------------------------------------------------
// Move git-dep locks (`~/.move/git/<repo>/.git/*.lock`)
// ---------------------------------------------------------------------------

// Walk `<moveHome>/git/<repo>/.git/` for git-owned `*.lock` files
// (`index.lock`, `sparse-checkout.lock`, etc.) older than the same
// 60s safety window `sweepStaleGitLocks` uses. Read-only — returns
// the absolute paths so the report rendering can show them and the
// `--clean-locks` branch can hand them off to `sweepStaleGitLocks`
// for removal under the same lock-key the engine uses at build time.
//
// Kept module-local because doctor is the only caller; the engine
// invokes `sweepStaleGitLocks` directly inside `withMoveBuildLock`.
const STALE_GIT_LOCK_AGE_MS = 60_000;
const GIT_LOCK_BASENAMES: ReadonlyArray<string> = [
	'index.lock',
	'HEAD.lock',
	'config.lock',
	'shallow.lock',
	'packed-refs.lock',
];
const GIT_INFO_LOCK_BASENAMES: ReadonlyArray<string> = ['sparse-checkout.lock'];

export const listStaleMoveGitLocks = (moveHome: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const root = nodePath.join(moveHome, 'git');
	let entries: ReadonlyArray<string>;
	try {
		entries = nodeFsSync.readdirSync(root);
	} catch {
		return out;
	}
	const now = Date.now();
	const ifStale = (p: string): boolean => {
		try {
			const st = nodeFsSync.statSync(p);
			return st.isFile() && now - st.mtimeMs >= STALE_GIT_LOCK_AGE_MS;
		} catch {
			return false;
		}
	};
	for (const entry of entries) {
		const full = nodePath.join(root, entry);
		// sui-cli per-repo lock sentinels (`.<repo>.lock` at the `git/`
		// root). Mirror the sweep — stale ones surface here so the
		// operator sees the same view the engine acts on at build time.
		if (entry.startsWith('.') && entry.endsWith('.lock')) {
			if (ifStale(full)) out.push(full);
			continue;
		}
		// git's own per-op locks inside `<repo>/.git/`.
		const gitDir = nodePath.join(full, '.git');
		for (const name of GIT_LOCK_BASENAMES) {
			const p = nodePath.join(gitDir, name);
			if (ifStale(p)) out.push(p);
		}
		const infoDir = nodePath.join(gitDir, 'info');
		for (const name of GIT_INFO_LOCK_BASENAMES) {
			const p = nodePath.join(infoDir, name);
			if (ifStale(p)) out.push(p);
		}
	}
	return out as ReadonlyArray<string>;
};

export { sweepStaleGitLocks };

export const moveGitLockCheck = (args: {
	staleMoveGitLocks: ReadonlyArray<string>;
	removedMoveGitLocks: ReadonlyArray<string>;
	cleanLocks: boolean;
}): Check => {
	const { staleMoveGitLocks, removedMoveGitLocks, cleanLocks } = args;
	if (staleMoveGitLocks.length === 0) {
		return {
			name: 'Move git-dep locks',
			ok: true,
			required: false,
			detail: 'no stale git locks under ~/.move/git/',
		};
	}
	if (!cleanLocks) {
		return {
			name: 'Move git-dep locks',
			ok: false,
			required: false,
			detail:
				`${staleMoveGitLocks.length} stale git lock${staleMoveGitLocks.length === 1 ? '' : 's'} under ~/.move/git/ ` +
				`— re-run with --clean-locks to remove (these block \`sui move build\`)`,
		};
	}
	return {
		name: 'Move git-dep locks',
		ok: true,
		required: false,
		detail: `removed ${removedMoveGitLocks.length} stale git lock${removedMoveGitLocks.length === 1 ? '' : 's'}`,
	};
};
