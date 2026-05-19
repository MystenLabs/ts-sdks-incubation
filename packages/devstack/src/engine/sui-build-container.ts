// SuiBuildContainer — one long-lived `sui move build` worker per
// `(app, stack)`.
//
// Why: Stage 1 of the publish-perf work replaced the tar-pipe build
// with bind-mounts (`-v <parent>:/workspace -v ~/.move:/root/.move`),
// which eliminated the cold git-deps cache that dominated v4 publishes.
// But each build still spent ~500-1000ms inside `docker run --rm`
// spawning a fresh container, setting up namespaces, and tearing it
// back down. With three or four publishes per cycle that adds up.
//
// Stage 2 (this module): start ONE container per `(app, stack)` at
// stack-acquire time, leave it sleeping, and `docker exec` each build
// into it. Per-build cost drops to ~50-100ms (exec only). The container
// keeps its bind-mounts to the host app dir and `~/.move`, so the
// build still writes outputs to the host source tree the user
// configured.
//
// Lifecycle:
//
//   - Acquire: `docker run -d --name devstack-<app>-<stack>-build
//     --entrypoint sleep -v <appDir>:/host -v ~/.move:/root/.move
//     <image> infinity`. Idempotent on resume — if a container by that
//     name is already running the SAME image we adopt it; if the image
//     drifted (user bumped `suiVersion`) we `docker rm -f` + recreate.
//
//   - Release: registered on the SuiBuildContainer layer's own scope.
//     Effect's MemoMap forks one scope per Layer.effect, so this
//     primitive's scope persists across cycles for as long as the
//     supervisor's outer scope stays alive — `r` (full rebuild)
//     cascades through the outer scope releasing every primitive in
//     dep order, while a targeted selective-restart only releases the
//     affected primitives.
//
// Trade-offs:
//
//   - The container is per `(app, stack)`, NOT per `(app, stack,
//     network)`. Switching networks within a stack would currently
//     reuse the same container; the image isn't network-dependent, so
//     this is fine.
//
//   - Source dirs outside `appDir` (uncommon — a user publishing a
//     Move package via an absolute path outside their app tree) aren't
//     reachable through the `/host` bind-mount. `canExec(hostPath)`
//     returns false in that case and the caller falls back to
//     `docker run --rm` per build (Stage 1 path).
//
//   - Two concurrent `runBuild` calls against the same source dir can
//     still race on the bind-mounted `build/`. Same trade-off Stage 1
//     accepted; not introduced by this layer.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Effect, Layer, Scope } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { ensureContainer } from './docker/ensure-container.js';
import { DockerError } from './errors.js';
import { Identity } from './identity.js';
import { isHolderLive } from './process-liveness.js';
import { ownLockBody, parseLockBody, releaseLockSync, serializeLockBody } from './file-lock.js';
import { resolveAppDir } from './resolve-app-dir.js';
import {
	runWithCapture,
	shellQuote,
	SuiBuildImage,
	SuiCliError,
	type SuiCliCapture,
	type Spawner,
} from './sui-cli.js';

export interface SuiBuildContainerShape {
	/** Resolved host-side mount point (the host's app dir). Bind-mounted
	 *  at `/host` inside the container. Exposed so callers can decide
	 *  whether a `hostPath` is reachable through this container without
	 *  re-deriving the dir. */
	readonly appDir: string;
	/** `true` when `hostPath` lives under `appDir` (and is therefore
	 *  reachable through the `/host` bind-mount). When `false`, the
	 *  caller must fall back to a per-build `docker run --rm` invocation
	 *  with a fresh mount of the package's parent dir. */
	readonly canExec: (hostPath: string) => boolean;
	/** Run `sui move build --path <hostPath>` inside the container.
	 *  Returns the captured stdout/stderr/exitCode so the caller can
	 *  parse the trailing JSON exactly the same way it does for the
	 *  `docker run --rm` fallback. Preconditions: `canExec(hostPath)`
	 *  is true. */
	readonly runBuild: (hostPath: string) => Effect.Effect<SuiCliCapture, SuiCliError>;
	/** Run `sui move summary --path <hostPath>` inside the container.
	 *  Used by the bindings codegen emitter — pre-fix it shelled out to
	 *  the HOST `sui` binary, which produces a different summary schema
	 *  than the build container's pinned `sui` (C7). Routing through
	 *  the container ensures the summary's shape matches what
	 *  `@mysten/codegen` expects. Preconditions: `canExec(hostPath)`
	 *  is true. */
	readonly runSummary: (hostPath: string) => Effect.Effect<SuiCliCapture, SuiCliError>;
}

export class SuiBuildContainer extends Context.Service<SuiBuildContainer, SuiBuildContainerShape>()(
	'@devstack/SuiBuildContainer',
) {}

// Container name format: `devstack-<app>-build`. Keyed by `app` only
// because the build container is network-agnostic (sui-cli's `move
// build` only compiles bytecode, never touches a chain) AND
// stack-agnostic (the bind-mount path is the same regardless of
// `<stack>` since the source tree lives under `<appDir>` per app, not
// per stack). Sharing one container per app means flipping
// `DEVSTACK_STACK=test pnpm test` against an already-warm `main` stack
// reuses the same `~/.move` cache + the same running container
// instead of paying a fresh image-pull + container-start cost. The
// trade-off: concurrent Move builds across stacks of the same app
// serialize through one container (the `docker exec` calls queue);
// for fully parallel builds, run from separate checkouts so the
// app identity differs.
// Exported for direct unit-test coverage; production callers only
// observe the resulting name indirectly via `docker inspect` records.
//
// `stack` is kept on the parameter shape so call sites that already
// thread an `Identity` don't need to be re-typed; we just don't read
// it.
export const containerNameFor = (identity: { app: string; stack?: string }): string =>
	`devstack-${identity.app}-build`;

// `docker rm -f` finalizer registered at the SuiBuildContainer layer's
// scope teardown. The build container has no on-disk state worth
// preserving (sleeper process, bind-mounts only); full removal at
// teardown keeps the host clean and ensures the next `pnpm dev` cycle
// sees a clean slate if the image was bumped.
const dockerRm = (spawner: Spawner, name: string): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		yield* runWithCapture(
			spawner,
			ChildProcess.make('docker', ['rm', '-f', name]),
			'docker rm (build container)',
		).pipe(Effect.ignore);
	});

// Adopt-or-create the build container. Delegates the entire
// adopt/resume/recreate/fresh state machine — plus TOCTOU recovery (Bug
// C) and name-collision recovery (Bug H) — to the shared
// `engine/docker/ensure-container.ts::ensureContainer` primitive. We
// just provide the `run` callback that spawns the sleeper container
// with our bind-mounts, and map the helper's DockerError envelope to
// SuiCliError so the build-error path renders uniformly.
//
// Pre-E1 this module hand-rolled its own state machine; the shared
// helper unifies it with `Docker.run`'s lifecycle (audit finding E1),
// removing the parallel TOCTOU + collision recovery code paths.
const ensureBuildContainer = (
	spawner: Spawner,
	name: string,
	imageTag: string,
	appDir: string,
	moveHome: string,
): Effect.Effect<void, SuiCliError, ChildProcessSpawner.ChildProcessSpawner> =>
	ensureContainer({
		name,
		image: imageTag,
		run: (ctx) =>
			Effect.gen(function* () {
				// Sui-build-container's lifecycle is strict-by-design — any
				// `docker start` failure other than the TOCTOU "no such
				// container" race should surface loudly rather than silently
				// recreating. The pre-E1 behavior was "fail on daemon
				// outage, fail on perms issues, only fall back on the
				// vanished-container race". The helper's default
				// `recreate-on-resume-failed` policy is right for the
				// long-running stateful containers Docker.run wraps, but
				// the build container has no state to defend AND the
				// strict failure surface is useful for diagnosing daemon
				// issues at acquire time. Reject the promotion here so the
				// outer `mapError` converts the failure into a SuiCliError
				// carrying the original docker stderr.
				if (ctx.reason === 'recreate' && ctx.recreateReason === 'resume-failed') {
					return yield* Effect.fail(
						new DockerError({
							phase: 'docker start',
							message:
								`failed to start build container '${name}': ` +
								`${ctx.resumeFailureStderr?.trim() ?? 'unknown error'}`,
							...(ctx.resumeFailureStderr !== undefined
								? { stderr: ctx.resumeFailureStderr }
								: {}),
						}),
					);
				}
				const args = [
					'run',
					'-d',
					'--name',
					name,
					'-v',
					`${appDir}:/host`,
					'-v',
					`${moveHome}:/root/.move`,
					'--entrypoint',
					'sleep',
					imageTag,
					'infinity',
				];
				// `runWithCapture` returns `SuiCliCapture` — but the helper's
				// `run` callback signature is `Effect<string, DockerError>`,
				// so we surface failures via DockerError here. The outer
				// `mapError` below maps any DockerError thrown through the
				// helper (including from the helper's internal `docker
				// inspect` / `docker start` / `docker rm` paths) back into
				// SuiCliError so downstream error rendering stays uniform.
				const captured = yield* runWithCapture(
					spawner,
					ChildProcess.make('docker', args),
					'docker run -d (build container)',
				).pipe(
					Effect.mapError(
						(err) =>
							new DockerError({
								phase: 'docker run',
								message: err.message,
								...(err.stdout !== undefined ? { stdout: err.stdout } : {}),
								...(err.stderr !== undefined ? { stderr: err.stderr } : {}),
								...(err.exitCode !== undefined ? { exitCode: err.exitCode } : {}),
							}),
					),
				);
				if (captured.exitCode !== 0 || captured.stdout.trim().length === 0) {
					return yield* Effect.fail(
						new DockerError({
							phase: 'docker run',
							message:
								`failed to start build container '${name}': ` +
								`${captured.stderr.trim() || captured.stdout.trim()}`,
							stdout: captured.stdout,
							stderr: captured.stderr,
							exitCode: captured.exitCode,
						}),
					);
				}
				return captured.stdout.trim();
			}),
	}).pipe(
		Effect.asVoid,
		Effect.mapError(
			(err) =>
				new SuiCliError({
					phase: 'docker run -d (build container)',
					message: `failed to ensure build container '${name}': ${err.message}`,
					...(err.stdout !== undefined ? { stdout: err.stdout } : {}),
					...(err.stderr !== undefined ? { stderr: err.stderr } : {}),
					...(err.exitCode !== undefined ? { exitCode: err.exitCode } : {}),
				}),
		),
	);

// -----------------------------------------------------------------------------
// Cross-process move-build lock (Bug D)
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
//   - O_EXCL create with stale-PID reclaim (via `tryClaimLockSync` /
//     `file-lock.ts`'s shared body codec).
//   - Bounded retry-with-backoff up to `MOVE_BUILD_LOCK_TIMEOUT_MS`.
//     Most builds hold the lock for seconds; a 5min ceiling absorbs
//     cold-cache git fetches without hanging CI.
//   - On timeout, fail with a typed SuiCliError that names the lock
//     path so the user can `rm` it manually if a stale lock from a
//     hard-killed peer survives our reclaim heuristic.
// -----------------------------------------------------------------------------

const MOVE_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MOVE_BUILD_LOCK_BASE_BACKOFF_MS = 100;
const MOVE_BUILD_LOCK_MAX_BACKOFF_MS = 2_000;

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

// Wrap an effect with cross-process move-build lock around its execution.
// `acquireRelease` guarantees the lock is freed on success, failure, or
// interruption — including SIGINT teardown. The lock spans ONLY the
// passed effect; container startup + summary calls remain unsynchronized.
//
// Exported so `engine/sui-cli.ts::buildMove` can apply the lock at the
// single host-wide funnel: every `sui move build` (host CLI, fresh
// `docker run --rm`, AND `docker exec` into SuiBuildContainer) shares
// `~/.move/git/<repo>/.git/` and must be serialized against itself.
// Wrapping only `SuiBuildContainer.runBuild` here would miss the two
// other code paths in `buildMove`; the per-build-container wrap was
// removed when this hoist landed.
//
// Stale-git-lock sweep: a previous run that was SIGKILL'd or crashed
// mid-`git sparse-checkout add` leaves a 0-byte
// `~/.move/git/<repo>/.git/index.lock` (or `sparse-checkout.lock`,
// `HEAD.lock`, `config.lock`, `shallow.lock`) on disk. The next build
// — even an otherwise-uncontended one — fails with
//   fatal: Unable to create '/root/.move/git/<repo>/.git/index.lock':
//   File exists. Another git process seems to be running in this
//   repository ...
// because git can't reclaim its own lock without a `--force` it doesn't
// expose. Our O_EXCL `~/.devstack/locks/sui-move-build-*.lock` makes
// no claim about git's internal locks; it only guarantees we're the
// only devstack process touching `~/.move/git/` right now. So while we
// hold it, sweep any git lock file whose mtime is older than a safety
// window (no live git process could possibly still be using it).
//
// We sweep BEFORE the body runs, after acquiring our lock — this
// ensures no peer devstack can be in the middle of a git op when we
// look. The age threshold defends against the (extremely-unlikely)
// case where a host-side `git` invocation outside devstack is mid-
// operation in `~/.move/git/`; 60s is well above any normal git
// op's runtime against a sparse-checkout dep cache.
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

// Run a `sui move build` inside the container against `/host/<rel>`.
// The Move.lock scrub is scoped to the package's subtree (so we don't
// re-scrub every Move.lock under appDir on every build).
const runBuildInside = (
	spawner: Spawner,
	containerName: string,
	containerPath: string,
): Effect.Effect<SuiCliCapture, SuiCliError> => {
	// In-container Move.lock scrub: stripping `[pinned.<env>.<pkg>]`
	// sections (see `containerBuildCmd`'s scrub for the rationale). The
	// awk program drives a stateful skip flag across the file; produced
	// via printf to avoid quote-nesting hell inside the surrounding
	// `sh -c` script.
	const stageAwk =
		`printf '%s\\n%s\\n%s\\n' '/^\\[pinned\\./ { skip=1; next }' ` +
		`'/^\\[/ && !/^\\[pinned\\./ { skip=0 }' '!skip { print }' > /tmp/scrub-move-lock.awk`;
	// Scope the scrub to the package + sibling deps (one level up so
	// `{ local = "../<dep>" }` references survive). Skips `.git` and
	// `node_modules` like the Stage 1 path.
	//
	// HIGH-R5: hardening against symlink-following root writes from
	// container to host. `-type f` skips symlinks (so a malicious
	// `Move.lock -> /etc/passwd` symlink in the source tree doesn't
	// get scrubbed), and `awk -i inplace` (gawk extension; available
	// in the mysten/sui base image's gawk) edits the file in-place
	// instead of going through `> $1.new && mv $1.new $1`. The
	// pre-fix shell pattern, when run as root inside the container
	// against a bind-mounted source tree, would have followed any
	// symlink target on the host filesystem.
	const scrubRoot = `${containerPath}/..`;
	// Explicit `gawk` (not `awk`) — the images/sui image's default awk is
	// mawk which doesn't support `-i inplace`. `[ -d /root/.move/git ]`
	// also scrubs the dep cache so freshly-downloaded testnet-pinned
	// upstream Move.locks don't trip the env-mismatch check.
	const scrub =
		`find ${shellQuote(scrubRoot)} -maxdepth 4 -type f -name Move.lock ` +
		`-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';' ; ` +
		`[ -d /root/.move/git ] && find /root/.move/git -type f -name Move.lock -not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';' || true`;
	const innerScript = [
		'set -e',
		stageAwk,
		scrub,
		// `-e testnet --no-tree-shaking` — sui-cli ≥ 1.71 requires `-e`,
		// and `--no-tree-shaking` keeps the build offline (the tree-
		// shaking pass otherwise tries to RPC the configured env's
		// fullnode to confirm dep digests). See
		// `engine/sui-cli.ts:containerBuildCmd` for full rationale.
		`exec sui move build --path ${shellQuote(containerPath)} -e testnet --no-tree-shaking --dump-bytecode-as-base64 --with-unpublished-dependencies`,
	].join('; ');
	const cmd = ChildProcess.make('docker', ['exec', containerName, 'sh', '-c', innerScript]);
	return runWithCapture(spawner, cmd, 'docker exec (sui move build)');
};

// Run `sui move summary` inside the build container against
// `/host/<rel>`. Mirrors `runBuildInside`'s shape minus the Move.lock
// scrub — `summary` doesn't mutate the package's lockfile, so the
// scrub is unnecessary noise here.
const runSummaryInside = (
	spawner: Spawner,
	containerName: string,
	containerPath: string,
): Effect.Effect<SuiCliCapture, SuiCliError> => {
	const cmd = ChildProcess.make('docker', [
		'exec',
		containerName,
		'sui',
		'move',
		'summary',
		'--path',
		containerPath,
		// Match `runBuildInside`'s env flag — `sui move summary` resolves
		// deps via the same `[pinned.<env>.*]` Move.lock entries, so the
		// same env-mismatch failure mode applies.
		'-e',
		'testnet',
	]);
	return runWithCapture(spawner, cmd, 'docker exec (sui move summary)');
};

// Translate a host path to its container view through the `/host`
// bind-mount. Returns `undefined` when the path is outside `appDir`
// (which means the caller must fall back to a per-build `docker run`).
// Exported for direct unit-test coverage of the translation matrix —
// edge cases (Windows backslashes, app-dir trailing slash, parent
// references) live in the test file rather than in this module's body.
export const toContainerPath = (appDir: string, hostPath: string): string | undefined => {
	const rel = path.relative(appDir, hostPath);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
	// Posix-joined under `/host`. On Windows the host-side path uses
	// backslashes; flip to forward slashes for the container.
	const posixRel = rel.split(path.sep).join('/');
	return path.posix.join('/host', posixRel);
};

// `Layer.effect` in Effect v4 absorbs Scope from the effect's R channel —
// it replaces 3.x's `Layer.scoped`. The acquire effect below pulls
// `Effect.scope`, which makes the underlying R include `Scope.Scope`;
// the layer is `Layer<SuiBuildContainer, …, never>` after composition.
export const SuiBuildContainerLive = Layer.effect(
	SuiBuildContainer,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const identity = yield* Identity;
		const image = yield* SuiBuildImage;
		if (image === undefined) {
			// Defensive: the wiring side (`suiLocalnet`) only registers
			// this layer when `SuiBuildImage` is set, but if a caller
			// composed it manually we'd rather fail loudly than start a
			// container against an unknown image.
			return yield* Effect.fail(
				new SuiCliError({
					phase: 'SuiBuildContainer acquire',
					message:
						'SuiBuildContainerLive requires SuiBuildImage to be provided (set by suiLocalnet).',
				}),
			);
		}
		// Attach the cleanup finalizer to the SuiBuildContainer layer's
		// own scope (the ambient `Scope` here, forked by Effect's
		// MemoMap). Selective-restart releases this scope only if
		// SuiBuildContainer is in the affected set; `r` cascades
		// through the supervisor's outer scope and releases every
		// primitive's scope.
		const cleanupScope = yield* Effect.scope;

		const appDir = resolveAppDir();
		const moveHome = path.join(os.homedir(), '.move');
		const containerName = containerNameFor(identity);

		yield* ensureBuildContainer(spawner, containerName, image.tag, appDir, moveHome);

		// `docker rm -f` is best-effort: a failure here (e.g. daemon
		// went away mid-shutdown) shouldn't fail the supervisor's
		// teardown sequence. The image gets reaped by the host docker's
		// own cleanup pass eventually.
		yield* Scope.addFinalizer(cleanupScope, dockerRm(spawner, containerName));

		return {
			appDir,
			canExec: (hostPath: string) => toContainerPath(appDir, hostPath) !== undefined,
			runBuild: (hostPath: string) => {
				const containerPath = toContainerPath(appDir, hostPath);
				if (containerPath === undefined) {
					return Effect.fail(
						new SuiCliError({
							phase: 'SuiBuildContainer.runBuild',
							message:
								`host path ${hostPath} is outside the bind-mounted app dir ${appDir}; ` +
								`caller must fall back to docker run --rm. Use canExec() to check first.`,
						}),
					);
				}
				// `sui move build` serialization (`~/.move/git/` race; see
				// `withMoveBuildLock` header) is applied at the
				// `engine/sui-cli.ts::buildMove` funnel so all three build
				// paths (host CLI, `docker run --rm`, this `docker exec`)
				// share one host-wide lock. Wrapping here would double-
				// acquire whenever `buildMove` routes to this branch.
				return runBuildInside(spawner, containerName, containerPath);
			},
			runSummary: (hostPath: string) => {
				const containerPath = toContainerPath(appDir, hostPath);
				if (containerPath === undefined) {
					return Effect.fail(
						new SuiCliError({
							phase: 'SuiBuildContainer.runSummary',
							message:
								`host path ${hostPath} is outside the bind-mounted app dir ${appDir}; ` +
								`caller must fall back to host sui. Use canExec() to check first.`,
						}),
					);
				}
				return runSummaryInside(spawner, containerName, containerPath);
			},
		};
	}),
);
