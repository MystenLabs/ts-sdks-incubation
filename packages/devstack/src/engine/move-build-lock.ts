// Cross-process lock + stale-git-lock sweep for `sui move build`.
//
// `sui move build` mutates `~/.move/git/<repo>/.git/` to pull or update
// upstream Move-package git dependencies — specifically the per-repo
// `.git/info/sparse-checkout.lock` and `.git/index.lock`. When two
// parallel devstack apps run a build concurrently against the SAME host,
// they share `~/.move/git/<repo>/`; git's own locks are per-process and
// the two builds race for them, surfacing as cryptic "Another git
// process seems to be running" errors that fail the build non-
// deterministically.
//
// We hold a coarse cross-process advisory lock (O_EXCL on a file under
// `~/.devstack/locks/`) ONLY across the `sui move build` invocation —
// not across stack acquire, not across docker exec startup, not across
// summary calls — so single-app workflows pay no extra cost and the
// container-lifecycle path stays unsynchronized.
//
// Acquire policy:
//   - O_EXCL create with stale-PID reclaim (via shared `file-lock.ts`
//     body codec).
//   - Bounded retry-with-backoff up to `MOVE_BUILD_LOCK_TIMEOUT_MS`.
//     Most builds hold the lock for seconds; a 5min ceiling absorbs
//     cold-cache git fetches without hanging CI.
//   - On timeout, fail with a typed `SuiCliError` that names the lock
//     path so the user can `rm` it manually if a stale lock from a
//     hard-killed peer survives our reclaim heuristic.
//
// Lives outside `engine/sui-build-container.ts` so `engine/sui-cli.ts`
// can import the lock without pulling the SuiBuildContainer service
// into its module graph (E51).

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';
import { SuiCliError } from './sui-cli.js';
import { ownLockBody, parseLockBody, releaseLockSync, serializeLockBody } from './file-lock.js';
import { isHolderLive } from './process-liveness.js';

const MOVE_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MOVE_BUILD_LOCK_BASE_BACKOFF_MS = 100;
const MOVE_BUILD_LOCK_MAX_BACKOFF_MS = 2_000;

/**
 * Default `~/.move` location. The shared resource every `sui move build`
 * mutates — bind-mounted into the build container at `/root/.move` and
 * used as the lock-key by `withMoveBuildLock`. Centralised here so the
 * three build paths (host CLI, `docker run --rm`, `docker exec` into
 * SuiBuildContainer) agree on the same default.
 */
export const defaultMoveHome = (): string => path.join(os.homedir(), '.move');

// Lock-key derivation: `~/.move` itself is the shared resource (every
// build mutates `<moveHome>/git/`). Hash the absolute moveHome path so
// two parallel devstacks pointing at the same `~/.move` agree on the
// lock file name across processes, while a developer with a non-default
// MOVE_HOME (e.g. a vendored ~/.move via env var) gets its own lock.
const moveBuildLockPath = (moveHome: string): string => {
	const repoHash = createHash('sha1').update(path.resolve(moveHome)).digest('hex').slice(0, 16);
	return path.join(os.homedir(), '.devstack', 'locks', `sui-move-build-${repoHash}.lock`);
};

interface MoveBuildLockHandle {
	readonly lockPath: string;
	readonly instanceId: string;
}

// Sync claim with retry-on-EEXIST. Tagged result mirrors `tryClaimLockSync`
// but loops with jittered backoff up to `MOVE_BUILD_LOCK_TIMEOUT_MS`.
// Async (Effect.sleep) so other fibers can run while we wait. Lock body
// includes the standard `{pid, startedAt, host, instanceId}` so a peer
// reclaimer can prove ownership via `releaseLockSync`'s instanceId check.
const acquireMoveBuildLock = (moveHome: string): Effect.Effect<MoveBuildLockHandle, SuiCliError> =>
	Effect.gen(function* () {
		const lockPath = moveBuildLockPath(moveHome);
		try {
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		} catch {
			// best-effort; writeFileSync below surfaces the real error
		}
		const deadline = Date.now() + MOVE_BUILD_LOCK_TIMEOUT_MS;
		let attempt = 0;
		let lastHolder: ReturnType<typeof parseLockBody> | undefined;
		while (true) {
			const body = ownLockBody({ withInstanceId: true, withAcquiredAt: true });
			try {
				fs.writeFileSync(lockPath, serializeLockBody(body), { flag: 'wx' });
				return { lockPath, instanceId: body.instanceId! };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					return yield* Effect.fail(
						new SuiCliError({
							phase: 'sui move build',
							message: `failed to claim move-build lock at ${lockPath}: ${(err as Error).message}`,
							cause: err,
						}),
					);
				}
			}
			// EEXIST — inspect holder. Reclaim if dead/unparseable.
			let raw: string | undefined;
			try {
				raw = fs.readFileSync(lockPath, 'utf8');
			} catch {
				// vanished between EEXIST and read — retry the O_EXCL on next loop tick
			}
			const holder = raw !== undefined ? parseLockBody(raw) : undefined;
			lastHolder = holder;
			if (holder === undefined || !isHolderLive(holder)) {
				// Stale — unlink (best-effort; O_EXCL on the next loop is the
				// canonical "did we win?" signal).
				try {
					fs.unlinkSync(lockPath);
				} catch {
					// ENOENT means a peer beat us; loop and retry
				}
				continue;
			}
			if (Date.now() >= deadline) {
				return yield* Effect.fail(
					new SuiCliError({
						phase: 'sui move build',
						message:
							`timed out after ${MOVE_BUILD_LOCK_TIMEOUT_MS / 1000}s waiting for move-build lock ${lockPath}. ` +
							`Held by pid=${lastHolder?.pid} host=${lastHolder?.host}. ` +
							`If that process is gone, remove the lock file: rm ${lockPath}`,
					}),
				);
			}
			const nominal = Math.min(
				MOVE_BUILD_LOCK_MAX_BACKOFF_MS,
				MOVE_BUILD_LOCK_BASE_BACKOFF_MS * 2 ** attempt,
			);
			const jittered = nominal * (0.5 + Math.random());
			yield* Effect.sleep(`${Math.floor(jittered)} millis`);
			attempt++;
		}
	});

const releaseMoveBuildLock = (handle: MoveBuildLockHandle): Effect.Effect<void> =>
	Effect.sync(() => {
		releaseLockSync(handle.lockPath, {
			pid: process.pid,
			startedAt: '',
			host: '',
			instanceId: handle.instanceId,
		});
	});

/**
 * Wrap an effect with the cross-process move-build lock around its
 * execution. `acquireRelease` guarantees the lock is freed on success,
 * failure, or interruption — including SIGINT teardown. The lock spans
 * ONLY the passed effect; container startup + summary calls remain
 * unsynchronized.
 *
 * Applied at the single host-wide funnel in `engine/sui-cli.ts::buildMove`:
 * every `sui move build` (host CLI, fresh `docker run --rm`, AND
 * `docker exec` into SuiBuildContainer) shares `~/.move/git/<repo>/.git/`
 * and must be serialized against itself.
 *
 * Stale-git-lock sweep: a previous run that was SIGKILL'd or crashed
 * mid-`git sparse-checkout add` leaves a 0-byte
 * `~/.move/git/<repo>/.git/index.lock` (or `sparse-checkout.lock`,
 * `HEAD.lock`, `config.lock`, `shallow.lock`) on disk. The next build —
 * even an otherwise-uncontended one — fails with
 *   fatal: Unable to create '/root/.move/git/<repo>/.git/index.lock':
 *   File exists. Another git process seems to be running in this
 *   repository ...
 * because git can't reclaim its own lock without a `--force` it doesn't
 * expose. Our O_EXCL `~/.devstack/locks/sui-move-build-*.lock` makes no
 * claim about git's internal locks; it only guarantees we're the only
 * devstack process touching `~/.move/git/` right now. So while we hold
 * it, sweep any git lock file whose mtime is older than a safety window
 * (no live git process could possibly still be using it).
 *
 * We sweep BEFORE the body runs, after acquiring our lock — this ensures
 * no peer devstack can be in the middle of a git op when we look. The
 * age threshold defends against the (extremely-unlikely) case where a
 * host-side `git` invocation outside devstack is mid-operation in
 * `~/.move/git/`; 60s is well above any normal git op's runtime against
 * a sparse-checkout dep cache.
 */
export const withMoveBuildLock = <A, E>(
	moveHome: string,
	body: Effect.Effect<A, E>,
): Effect.Effect<A, E | SuiCliError> =>
	Effect.acquireUseRelease(
		acquireMoveBuildLock(moveHome),
		() =>
			Effect.gen(function* () {
				yield* sweepStaleGitLocks(moveHome);
				return yield* body;
			}),
		releaseMoveBuildLock,
	);

// File names git creates as its own per-op locks. Each is a 0-byte
// sentinel that git unlinks when its operation completes; a crash
// leaves it behind and blocks the next op against the same repo.
const GIT_LOCK_NAMES: ReadonlyArray<string> = [
	'index.lock',
	'HEAD.lock',
	'config.lock',
	'shallow.lock',
	'packed-refs.lock',
];

// Lock files inside `<repo>/.git/info/` (sparse-checkout writes its
// lock here, not at the .git root).
const GIT_INFO_LOCK_NAMES: ReadonlyArray<string> = ['sparse-checkout.lock'];

// Age threshold below which we conservatively assume a real git
// process might still be running. 60s is well above any normal git op
// against a sparse-checkout dep cache (sui-cli's git fetches take
// seconds, not minutes).
const STALE_GIT_LOCK_AGE_MS = 60_000;

/**
 * Walk `<moveHome>/git/` and remove stale lock files left by previous
 * SIGKILL'd or crashed `sui move build` runs.
 *
 * Two flavors are swept (both gated on a 60s mtime safety window so a
 * real in-flight operation is never disturbed):
 *
 *  - `.<repo>.lock` at the `git/` root — sui-cli's own per-repo lock
 *    sentinel (created by its rust-side `flock` wrapper around git ops).
 *  - `<repo>/.git/{index,HEAD,config,shallow,packed-refs}.lock` and
 *    `<repo>/.git/info/sparse-checkout.lock` — git's internal per-op
 *    lock files. A previous crash mid-`git sparse-checkout add` is the
 *    most common offender; the 0-byte index.lock survives the parent
 *    sui-cli process and the next build trips on "Unable to create
 *    '.git/index.lock': File exists. Another git process seems to be
 *    running ...".
 *
 * Used inside `withMoveBuildLock` so the sweep runs while we hold the
 * cross-process devstack lock — no peer can be racing into a git op
 * while we look. Best-effort: missing dirs, unreadable entries, and
 * unlink races all surface as silent no-ops (the build itself will
 * still fail loudly if a stale lock survives).
 *
 * Exported so `cli/commands/doctor.ts` + `cli/commands/wipe.ts` can
 * call it directly (doctor reports them, `--clean-locks` removes;
 * wipe sweeps unconditionally as part of its destructive cleanup).
 */
export const sweepStaleGitLocks = (moveHome: string): Effect.Effect<ReadonlyArray<string>> =>
	Effect.sync(() => {
		const removed: Array<string> = [];
		const root = path.join(moveHome, 'git');
		let entries: ReadonlyArray<string>;
		try {
			entries = fs.readdirSync(root);
		} catch {
			return removed;
		}
		const now = Date.now();
		for (const entry of entries) {
			const fullEntry = path.join(root, entry);
			// sui-cli per-repo locks (`.<repo>.lock`) live at the `git/`
			// root as 0-byte sentinel files. A crashed sui-cli leaves
			// them behind and the next sui-cli invocation refuses to
			// touch the repo. Same 60s safety window as git's own locks.
			if (entry.startsWith('.') && entry.endsWith('.lock')) {
				if (maybeRemoveStaleLock(fullEntry, now)) {
					removed.push(fullEntry);
				}
				continue;
			}
			// Real per-repo dirs: walk `<repo>/.git/` for git's own
			// per-op lock files. Anything else under the entry (regular
			// files, dotfiles that aren't `.lock`) is intentionally
			// untouched.
			const gitDir = path.join(fullEntry, '.git');
			for (const name of GIT_LOCK_NAMES) {
				if (maybeRemoveStaleLock(path.join(gitDir, name), now)) {
					removed.push(path.join(gitDir, name));
				}
			}
			const infoDir = path.join(gitDir, 'info');
			for (const name of GIT_INFO_LOCK_NAMES) {
				if (maybeRemoveStaleLock(path.join(infoDir, name), now)) {
					removed.push(path.join(infoDir, name));
				}
			}
		}
		return removed as ReadonlyArray<string>;
	});

const maybeRemoveStaleLock = (lockPath: string, nowMs: number): boolean => {
	let st: fs.Stats;
	try {
		st = fs.statSync(lockPath);
	} catch {
		return false;
	}
	if (!st.isFile()) return false;
	if (nowMs - st.mtimeMs < STALE_GIT_LOCK_AGE_MS) return false;
	try {
		fs.unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
};
