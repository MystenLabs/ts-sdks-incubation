// Plugin-author primitive: clone (or update) a git repo at a fixed
// ref into a content-addressed cache dir, returning the local path.
//
// Used by walrus / seal primitives to grab upstream Move sources
// without an in-tree checkout. The cache dir is keyed on
// `sha256(repo@ref).slice(0,12)`, so the same `{repo, ref}` reuses
// the same dir across runs (ref is treated as immutable for caching
// purposes — pinned tags / SHAs).
//
// Subprocess work goes through `ChildProcessSpawner` (Node binding
// provided upstream by `NodeChildProcessSpawner`). Filesystem work
// goes through `FileSystem` (provided by `NodeFileSystem`).

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { tag } from '../tag.js';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class GitFetchError extends Schema.TaggedErrorClass<GitFetchError>()('GitFetchError', {
	message: Schema.String,
	// Optional captured streams + exit code from the `git` subprocess that
	// produced this failure. pretty-error.ts surfaces these when present
	// so clone/checkout failures (auth errors, missing ref, etc.) are
	// debuggable without re-running.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

const gitFetchError =
	(name: string) =>
	(cause: unknown): GitFetchError =>
		new GitFetchError({
			message: `gitFetch '${name}': ${stringifyCause(cause)}`,
			cause,
		});

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface GitFetchOptions<Name extends string> {
	readonly name: Name;
	/** Passed to `git clone` after a transport allowlist check. Only
	 *  `https://`, `git://`, and `ssh://` URLs (plus the conventional
	 *  `git@host:owner/repo.git` SCP-style shorthand) are accepted.
	 *  `ext::` (arbitrary command), `file://` (local-only, surprising
	 *  in CI), and bare `-`-prefixed strings (which `git` interprets
	 *  as flags) are rejected at the boundary so a config-time typo or
	 *  malicious upstream cache entry can't smuggle a different
	 *  transport. */
	readonly repo: string;
	readonly ref: string; // tag, sha, or branch
	readonly subdirectory?: string; // path within the repo
}

// Treat the SCP-style `git@host:owner/repo.git` shorthand as `ssh://`
// for transport-allowlist purposes — it's the canonical form a
// `pnpm exec` user copies from a GitHub clone button.
const SCP_STYLE_REPO_RE = /^[\w.-]+@[\w.-]+:[\w./-]+(?:\.git)?$/;
const ALLOWED_TRANSPORTS: ReadonlyArray<string> = ['https://', 'http://', 'git://', 'ssh://'];

const validateRepoUrl = (repo: string): void => {
	if (repo.length === 0) {
		throw new Error('gitFetch: repo must not be empty');
	}
	if (repo.startsWith('-')) {
		// `git clone -<flag> ...` would parse this as a flag instead of
		// a positional arg, even with `--` separators in some envs.
		throw new Error(`gitFetch: repo '${repo}' starts with '-' (rejected to avoid CLI flag injection)`);
	}
	if (SCP_STYLE_REPO_RE.test(repo)) return;
	for (const transport of ALLOWED_TRANSPORTS) {
		if (repo.startsWith(transport)) return;
	}
	throw new Error(
		`gitFetch: repo '${repo}' uses a disallowed transport. ` +
			`Allowed: https://, http://, git://, ssh://, or git@host:owner/repo.git.`,
	);
};

// Defense-in-depth ref validator. git would reject these at clone time
// anyway, but failing here points the stack trace at the user's
// `gitFetch({ref: ...})` config rather than deep inside the Effect chain
// where the error is harder to attribute. Conservative — rejects
// obvious malformed refs (empty, whitespace-bearing, leading `-` flag
// injection, embedded refs like `@@`) and trusts git's
// `check-ref-format` to catch the rest at clone time.
const VALID_REF_CHARS = /^[A-Za-z0-9_/.@+\-=:]+$/;
const validateRef = (ref: string): void => {
	if (ref.length === 0) {
		throw new Error('gitFetch: ref must not be empty');
	}
	if (ref.startsWith('-')) {
		throw new Error(`gitFetch: ref '${ref}' starts with '-' (rejected to avoid CLI flag injection)`);
	}
	if (!VALID_REF_CHARS.test(ref)) {
		throw new Error(
			`gitFetch: ref '${ref}' contains characters outside the allowed set ` +
				`(alphanumeric, _ / . @ + - = :). Git would reject this anyway; flagging at ` +
				`factory-construction time so the stack trace points at the user config.`,
		);
	}
	if (ref.includes('@@')) {
		throw new Error(`gitFetch: ref '${ref}' contains '@@' (typo for '@'?)`);
	}
};

export interface GitFetched {
	readonly path: string; // absolute path to the (optionally subdirectory'd) checkout
	readonly ref: string;
	readonly sha: string; // resolved commit sha
}

// Internal helper aliases for the resolved service shapes, so helper
// signatures don't have to spell out the Context.Service index.
type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export const gitFetch = <const Name extends string>(options: GitFetchOptions<Name>) => {
	// Validate the repo URL + ref synchronously at factory construction
	// so disallowed values surface at config-load time (where the stack
	// trace points at the user's `gitFetch({...})` call) rather than at
	// acquire time deep inside an Effect chain.
	validateRepoUrl(options.repo);
	validateRef(options.ref);
	return tag(
		options.name,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			const mapErr = gitFetchError(options.name);

			// 1. Cache layout: `<stateDir>/git/<name>/<refHash>` where the
			//    hash is a short content-address of `repo@ref`. State dir
			//    defaults to `.devstack` (overridable via env), matching
			//    the state-store convention.
			const stateDir = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
			const refHash = crypto
				.createHash('sha256')
				.update(`${options.repo}@${options.ref}`)
				.digest('hex')
				.slice(0, 12);
			const parentDir = path.resolve(stateDir, 'git', options.name);
			const cloneDir = path.join(parentDir, refHash);

			yield* Effect.annotateCurrentSpan({
				'git.repo': options.repo,
				'git.ref': options.ref,
				'git.dir': cloneDir,
			});

			// 2. Warm-cache check. If the dir exists, ask git for its
			//    current HEAD. A non-empty SHA is the strongest signal the
			//    previous clone completed cleanly — anything else (missing
			//    .git, partial clone, foreign tree) falls through to a
			//    fresh clone.
			const cachedSha = yield* checkCachedHead(spawner, fs, cloneDir).pipe(
				Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
			);

			let sha: string;
			if (cachedSha !== undefined) {
				sha = cachedSha;
			} else {
				// 3. Cold path: wipe a partial dir if present, mkdir
				//    parents, then clone. Try a shallow clone first (works
				//    for tags / branches); fall back to a full clone +
				//    checkout if the ref is a sha or the host rejects
				//    shallow.
				//
				// Phase G: GC sibling refHash dirs under the same `parentDir`
				// before cloning. A moving branch ref (`ref: 'main'`) cuts a
				// new refHash on every upstream advance — without GC each new
				// fetch leaves the prior clone parked under `<parentDir>/<old-hash>`
				// forever. Bound the cache to "one entry per (repo, name)" by
				// removing any sibling that's not us. Best-effort: a failure
				// here never blocks the clone.
				const siblingsToGc = yield* fs
					.readDirectory(parentDir)
					.pipe(
						Effect.map((entries) => entries.filter((e) => e !== refHash)),
						Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
					);
				for (const sibling of siblingsToGc) {
					yield* fs
						.remove(path.join(parentDir, sibling), { recursive: true, force: true })
						.pipe(Effect.ignore);
				}
				yield* fs
					.remove(cloneDir, { recursive: true, force: true })
					.pipe(Effect.ignore);
				yield* fs.makeDirectory(parentDir, { recursive: true }).pipe(Effect.mapError(mapErr));

				const shallowOk = yield* runGit(spawner, [
					'clone',
					'--quiet',
					'--depth',
					'1',
					'--branch',
					options.ref,
					options.repo,
					cloneDir,
				]).pipe(Effect.orElseSucceed(() => false));

				if (!shallowOk) {
					// Shallow clone failed (ref is a sha, server refused,
					// etc.). Clean and fall back to a full clone +
					// checkout.
					yield* fs
						.remove(cloneDir, { recursive: true, force: true })
						.pipe(Effect.ignore);
					yield* runGit(spawner, ['clone', '--quiet', options.repo, cloneDir]).pipe(
						Effect.mapError(mapErr),
					);
					yield* runGit(spawner, ['-C', cloneDir, 'checkout', '--quiet', options.ref]).pipe(
						Effect.mapError(mapErr),
					);
				}

				// 4. Capture the resolved commit sha.
				sha = yield* captureGit(spawner, ['-C', cloneDir, 'rev-parse', 'HEAD']).pipe(
					Effect.mapError(mapErr),
				);
			}

			// 5. Final path: drill into subdirectory if requested, and
			//    validate it exists inside the clone. The subdirectory is
			//    resolved against `cloneDir` and checked to fall back
			//    inside it — a config with `subdirectory: '../../etc'`
			//    must not escape the cache root.
			let finalPath = cloneDir;
			if (options.subdirectory !== undefined) {
				const joined = path.resolve(cloneDir, options.subdirectory);
				const rel = path.relative(cloneDir, joined);
				if (rel.startsWith('..') || path.isAbsolute(rel)) {
					return yield* Effect.fail(
						new GitFetchError({
							message: `gitFetch '${options.name}': subdirectory '${options.subdirectory}' escapes clone dir`,
						}),
					);
				}
				finalPath = joined;
				const exists = yield* fs.exists(finalPath).pipe(Effect.mapError(mapErr));
				if (!exists) {
					return yield* Effect.fail(
						new GitFetchError({
							message: `gitFetch '${options.name}': subdirectory '${options.subdirectory}' missing in ${options.repo}@${options.ref}`,
						}),
					);
				}
			}

			return { path: finalPath, ref: options.ref, sha } satisfies GitFetched;
		}).pipe(Effect.withSpan(`gitFetch(${options.name})`)),
		{
			// Hidden from the TUI: the clone is a cache-warming detail whose
			// only useful artifact (the local path) is consumed by the parent
			// primitive that yielded this tag. Surfacing it as a row added
			// noise without actionable state — the path is a long state-dir
			// hash, and a failure here propagates through the consumer's
			// own failure row.
			hidden: true,
		},
	);
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Check whether `dir` already contains a valid checkout. Returns the
// resolved HEAD sha on success, `undefined` if the dir is missing.
// Fails (typed) if the dir exists but `git rev-parse` errors — caller
// catches that as "no cache, re-fetch".
const checkCachedHead = (
	spawner: Spawner,
	fs: Fs,
	dir: string,
): Effect.Effect<string | undefined, GitFetchError> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return undefined;
		const sha = yield* captureGit(spawner, ['-C', dir, 'rev-parse', 'HEAD']);
		return sha.length > 0 ? sha : undefined;
	});

// Run a git subcommand, fail on non-zero exit. Returns `true` on
// success so callers can lift exit-code failures into a typed
// fallback without losing the error channel.
const runGit = (
	spawner: Spawner,
	args: ReadonlyArray<string>,
): Effect.Effect<boolean, GitFetchError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cmd = ChildProcess.make('git', [...args]);
			const mapSpawnErr = (cause: unknown): GitFetchError =>
				new GitFetchError({
					message: `git ${args.join(' ')} failed: ${stringifyCause(cause)}`,
					cause,
				});
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnErr));
			const decode = <E>(stream: Stream.Stream<Uint8Array, E>) =>
				Stream.mkString(Stream.decodeText(stream));
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					decode(handle.stdout).pipe(Effect.mapError(mapSpawnErr)),
					decode(handle.stderr).pipe(Effect.mapError(mapSpawnErr)),
					handle.exitCode.pipe(Effect.mapError(mapSpawnErr)),
				],
				{ concurrency: 'unbounded' },
			);
			const code = exitCode as number;
			if (code !== 0) {
				return yield* Effect.fail(
					new GitFetchError({
						message: `git ${args.join(' ')} exited with code ${code}`,
						stdout,
						stderr,
						exitCode: code,
					}),
				);
			}
			return true;
		}),
	);

// Run a git subcommand and return its trimmed stdout.
const captureGit = (
	spawner: Spawner,
	args: ReadonlyArray<string>,
): Effect.Effect<string, GitFetchError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cmd = ChildProcess.make('git', [...args]);
			const mapSpawnErr = (cause: unknown): GitFetchError =>
				new GitFetchError({
					message: `git ${args.join(' ')} failed: ${stringifyCause(cause)}`,
					cause,
				});
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnErr));
			const decode = <E>(stream: Stream.Stream<Uint8Array, E>) =>
				Stream.mkString(Stream.decodeText(stream));
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					decode(handle.stdout).pipe(Effect.mapError(mapSpawnErr)),
					decode(handle.stderr).pipe(Effect.mapError(mapSpawnErr)),
					handle.exitCode.pipe(Effect.mapError(mapSpawnErr)),
				],
				{ concurrency: 'unbounded' },
			);
			const code = exitCode as number;
			if (code !== 0) {
				return yield* Effect.fail(
					new GitFetchError({
						message: `git ${args.join(' ')} exited with code ${code}`,
						stdout,
						stderr,
						exitCode: code,
					}),
				);
			}
			return stdout.trim();
		}),
	);
