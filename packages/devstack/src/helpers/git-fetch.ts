import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

const exec = promisify(execFile);

export type GitUrlResolver = (repo: string, rev: string) => string;

export interface GitFetchOptions {
	/** Logical node name. Default `'git.<sluggified-repo>@<rev>'`. */
	name?: string;
	/** Repository identifier. Default URL builder treats it as a GitHub
	 * `owner/repo` slug; pass a function `gitUrl: (repo, rev) => url`
	 * for full programmatic control over the clone URL (private hosts,
	 * `file://` URLs in tests, GitLab, etc.). */
	repo: string;
	/** Commit SHA, branch, or tag. Used as both the checkout target
	 * and part of the on-disk cache key. */
	rev: string;
	/** Optional path inside the repo. The `path` Dep returns
	 * `<cacheDir>/<subdir>` rather than the repo root. */
	subdir?: string;
	/** Override how the URL is constructed. Default builds
	 * `https://github.com/<repo>.git`. */
	gitUrl?: string | GitUrlResolver;
	/** Override the cache root. Default `<env.appDir>/.devstack/imports/`.
	 * Tests typically override to a temp dir. */
	cacheRoot?: string;
}

export interface GitFetchState {
	/** Filesystem path consumers should read from. Equals
	 * `<cacheDir>/<subdir>` when subdir is set; otherwise `<cacheDir>`. */
	path: string;
	/** The cache directory itself (without subdir). */
	cacheDir: string;
	/** The clone URL we used. */
	url: string;
	/** Resolved commit SHA (after a fresh clone, this is `git rev-parse
	 * HEAD` in the cache). For warm-restart cases where prior matched,
	 * this is the previously-recorded SHA. */
	sha: string;
	rev: string;
	repo: string;
}

const provides = {
	path: dep((s: GitFetchState) => s.path),
	cacheDir: dep((s: GitFetchState) => s.cacheDir),
	sha: dep((s: GitFetchState) => s.sha),
	full: dep((s: GitFetchState) => s),
} satisfies Provides<GitFetchState>;

// `gitFetch({ repo, rev, subdir? })` — fetch an upstream git repo at
// a fixed rev into a content-addressed cache dir. The result's `path`
// Dep can be chained into `publishMove({ path: src.get('path'), ... })`
// for vendoring upstream Move packages without an in-tree checkout.
//
// Cache layout: `<cacheRoot>/<sluggified-repo>@<rev>/`. Same `repo+rev`
// reuses the same dir; rev change makes a new dir (old one stays
// around as a cache — `reset` cleans them up by virtue of removing
// the stack dir, since cacheRoot defaults under `.devstack/`).
//
// Warm restart: if `prior.cacheDir` matches the desired path AND the
// dir exists, no re-fetch — the rev is immutable, so the on-disk
// content is what we already had. Empty (failed mid-clone) cache
// dirs are detected and re-fetched.
//
// Pure-helper, not plugin-shaped: no schema, no provides catalog,
// just a producer factory. Compose freely in user configs:
//
//   const deepbookSrc = gitFetch({
//     repo: 'MystenLabs/deepbookv3',
//     rev: 'v7.0.0',
//     subdir: 'packages/deepbook',
//   });
//   const deepbookPub = publishMove({
//     name: 'deepbook',
//     path: deepbookSrc.get('path'),
//     signer: accounts.get('signer', { name: 'publisher' }),
//     publish: ...,
//   });
export function gitFetch(opts: GitFetchOptions) {
	if (!opts.repo) throw new Error('gitFetch: `repo` is required');
	if (!opts.rev) throw new Error('gitFetch: `rev` is required');

	const url = resolveGitUrl(opts.repo, opts.rev, opts.gitUrl);
	const slug = sluggify(opts.repo);
	const cacheKey = `${slug}@${opts.rev}`;
	const name = opts.name ?? `git.${cacheKey}`;

	return define<GitFetchState, typeof provides>({
		name,
		provides,
		inputs: () => ({ url, rev: opts.rev, subdir: opts.subdir ?? '' }),
		start: async ({ env, prior, log }) => {
			const cacheRoot = opts.cacheRoot ?? join(env.appDir, '.devstack', 'imports');
			const cacheDir = resolve(cacheRoot, cacheKey);
			const path = opts.subdir ? join(cacheDir, opts.subdir) : cacheDir;

			if (
				prior &&
				prior.cacheDir === cacheDir &&
				existsSync(cacheDir) &&
				dirNonEmpty(cacheDir)
			) {
				return prior;
			}
			// Stale or absent — re-fetch from scratch. Wipe a partial
			// dir first so a half-completed prior clone doesn't trip up
			// `git clone <dir>` (which refuses to clone into an existing
			// non-empty dir).
			if (existsSync(cacheDir)) {
				await rm(cacheDir, { recursive: true, force: true });
			}
			mkdirSync(cacheRoot, { recursive: true });

			log(`git clone ${url} → ${cacheDir} (rev ${opts.rev})`);
			await exec('git', ['clone', '--quiet', url, cacheDir]);
			// `git checkout` against an arbitrary rev (sha, branch, tag).
			// Detached-HEAD is fine — we only read the working tree.
			await exec('git', ['-C', cacheDir, 'checkout', '--quiet', opts.rev]);
			const { stdout } = await exec('git', ['-C', cacheDir, 'rev-parse', 'HEAD']);
			const sha = stdout.trim();

			if (opts.subdir !== undefined && !existsSync(path)) {
				throw new Error(
					`gitFetch("${opts.repo}@${opts.rev}"): subdir '${opts.subdir}' missing in cloned tree`,
				);
			}

			return {
				path,
				cacheDir,
				url,
				sha,
				rev: opts.rev,
				repo: opts.repo,
			};
		},
	});
}

function resolveGitUrl(
	repo: string,
	rev: string,
	override: GitFetchOptions['gitUrl'],
): string {
	if (typeof override === 'function') return override(repo, rev);
	if (typeof override === 'string') return override.replace('<repo>', repo);
	return `https://github.com/${repo}.git`;
}

function sluggify(repo: string): string {
	return repo
		.replace(/[^a-zA-Z0-9._-]/g, '_')
		.toLowerCase();
}

function dirNonEmpty(dir: string): boolean {
	try {
		const st = statSync(dir);
		if (!st.isDirectory()) return false;
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}
