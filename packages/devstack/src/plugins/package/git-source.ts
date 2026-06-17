// Materialize a remote git Move source into a persistent local cache.
//
// `localPackage(name, { git: { url, subdir?, rev? } })` points the build at a
// repository instead of a vendored local tree. This helper clones the repo
// host-side (cached by url+rev), then hands the existing local-build flow a
// plain on-disk path — every downstream step (`hashMoveSources`,
// `scrubLocksHost`, `executor.build`, codegen) is unchanged because it only
// ever sees a directory.
//
// The package's OWN transitive deps (e.g. deepbook → token, or the Sui
// framework) still resolve in-container during `sui move build`; cloning the
// whole repo also means sibling `{ local = "../x" }` deps resolve naturally.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Effect } from 'effect';

import { publishError, type PublishError } from './errors.ts';

const execFileAsync = promisify(execFile);

/** Remote git Move source coordinates. Prefer an IMMUTABLE `rev` (a commit
 *  SHA or a tag): a branch like `main` is cached at first sight and won't
 *  auto-refresh until the cache entry is removed. */
export interface GitSource {
	readonly url: string;
	/** Sub-path within the repo to build from (e.g. `packages/deepbook`).
	 *  Omit to build the repo root. */
	readonly subdir?: string;
	/** Branch, tag, or commit SHA. Defaults to `HEAD` (the remote default
	 *  branch). */
	readonly rev?: string;
}

// Host-global cache, shared across stacks/apps/runs and keyed by (url, rev) so
// a committed pin re-uses the same clone forever. Kept OUTSIDE the stack root
// (like `~/.move`): it is content-pinned dep input, not per-stack state, so it
// must survive `wipe` and snapshot bounces.
const gitCacheRoot = (): string => join(homedir(), '.devstack', 'git-src');

const cacheDirFor = (url: string, rev: string): string => {
	const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 16);
	// A readable rev slug aids debugging; the url hash keeps it unambiguous.
	const safeRev = rev.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
	return join(gitCacheRoot(), `${urlHash}-${safeRev}`);
};

const CLONE_TIMEOUT_MS = 5 * 60_000;

/**
 * Clone `git` into the host cache (or reuse an existing clone) and return the
 * local path to build from — `<cache>/<subdir>` when `subdir` is set, else the
 * repo root.
 *
 * Idempotent + safe to call from both `inputIdentity` and `start`: a completed
 * clone is marked with a `.devstack-ok` sentinel, so the second call is a cheap
 * `access` hit. Concurrent first-clones of the SAME (url, rev) are reconciled
 * by the atomic directory rename — the loser discards its temp clone and reuses
 * the winner's, so no lock is needed. (Different (url, rev) clone independently;
 * the build itself is serialized separately by `withMoveBuildLock`.)
 */
export const materializeGitSource = (
	git: GitSource,
	packageName: string,
): Effect.Effect<string, PublishError> =>
	Effect.tryPromise({
		try: async () => {
			const rev = git.rev ?? 'HEAD';
			const cacheDir = cacheDirFor(git.url, rev);
			const finalPath = git.subdir ? join(cacheDir, git.subdir) : cacheDir;
			const okMarker = join(cacheDir, '.devstack-ok');

			// Cache hit — a prior apply already materialized this (url, rev).
			try {
				await access(okMarker);
				return finalPath;
			} catch {
				// miss — clone below.
			}

			await mkdir(gitCacheRoot(), { recursive: true });
			const staging = await mkdtemp(join(tmpdir(), 'devstack-git-'));
			try {
				try {
					// Fast path: branch/tag name — a shallow single-branch clone.
					await execFileAsync(
						'git',
						['clone', '--depth', '1', '--branch', rev, '--', git.url, staging],
						{ timeout: CLONE_TIMEOUT_MS },
					);
				} catch {
					// `--branch` rejects bare commit SHAs (and some servers won't
					// resolve a SHA that way). Fall back to init + shallow fetch of
					// the exact rev + checkout, which works for a SHA, tag, or
					// branch on any server that allows fetching the ref.
					await rm(staging, { recursive: true, force: true });
					await mkdir(staging, { recursive: true });
					await execFileAsync('git', ['init', '-q', staging], { timeout: CLONE_TIMEOUT_MS });
					await execFileAsync('git', ['-C', staging, 'remote', 'add', 'origin', git.url], {
						timeout: CLONE_TIMEOUT_MS,
					});
					await execFileAsync(
						'git',
						['-C', staging, 'fetch', '--depth', '1', 'origin', '--', rev],
						{ timeout: CLONE_TIMEOUT_MS },
					);
					await execFileAsync('git', ['-C', staging, 'checkout', '-q', 'FETCH_HEAD'], {
						timeout: CLONE_TIMEOUT_MS,
					});
				}
				await writeFile(join(staging, '.devstack-ok'), '');
				// Publish atomically. If a concurrent apply already won the race,
				// the rename fails (target exists) — discard ours and reuse theirs.
				try {
					await rename(staging, cacheDir);
				} catch {
					await rm(staging, { recursive: true, force: true }).catch(() => {});
				}
			} catch (cause) {
				await rm(staging, { recursive: true, force: true }).catch(() => {});
				throw cause;
			}
			return finalPath;
		},
		catch: (cause): PublishError =>
			publishError('hash', {
				sourcePath: git.subdir ? `${git.url}#${git.subdir}` : git.url,
				packageName,
				message:
					`failed to materialize git source ${git.url} (rev=${git.rev ?? 'HEAD'}` +
					`${git.subdir ? `, subdir=${git.subdir}` : ''}): ` +
					`${String((cause as Error)?.message ?? cause)}`,
				cause,
			}),
	});
