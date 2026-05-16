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
//   - Release: registered on `LongLivedScope` when present, falling
//     back to the layer-build scope otherwise. Mirrors how `Docker.run`
//     parks reusable containers across `r` hot-restarts: the per-cycle
//     scope tears down but the build container survives, ready for the
//     next cycle's first publish.
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

import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Effect, Layer, Scope } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Identity } from './identity.js';
import { LongLivedScope } from './long-lived-scope.js';
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
	readonly runBuild: (
		hostPath: string,
	) => Effect.Effect<SuiCliCapture, SuiCliError>;
	/** Run `sui move summary --path <hostPath>` inside the container.
	 *  Used by the bindings codegen emitter — pre-fix it shelled out to
	 *  the HOST `sui` binary, which produces a different summary schema
	 *  than the build container's pinned `sui` (C7). Routing through
	 *  the container ensures the summary's shape matches what
	 *  `@mysten/codegen` expects. Preconditions: `canExec(hostPath)`
	 *  is true. */
	readonly runSummary: (
		hostPath: string,
	) => Effect.Effect<SuiCliCapture, SuiCliError>;
}

export class SuiBuildContainer extends Context.Service<
	SuiBuildContainer,
	SuiBuildContainerShape
>()('@devstack/SuiBuildContainer') {}

// Container name format: `devstack-<app>-<stack>-build`. Per `(app,
// stack)` — network is not part of the name because the build container
// is network-agnostic (sui-cli's `move build` is purely local). Two
// stacks against the same app (e.g. `main` vs `test`) get DIFFERENT
// build containers so they don't share bind-mounts when running
// concurrently — the user explicitly opted into that isolation.
// Exported for direct unit-test coverage; production callers only
// observe the resulting name indirectly via `docker inspect` records.
export const containerNameFor = (identity: { app: string; stack: string }): string =>
	`devstack-${identity.app}-${identity.stack}-build`;

interface InspectResult {
	readonly running: boolean;
	readonly image: string;
}

// Read the container's current state. Returns `null` if no container
// by that name exists. Mirrors the inspect helper in `docker/core.ts`
// but kept module-local — coupling the two would force core.ts to
// take a hard dep on this module (or vice versa).
const inspectContainer = (
	spawner: Spawner,
	name: string,
): Effect.Effect<InspectResult | null, never> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}|{{.Config.Image}}',
			name,
		]);
		const captured = yield* runWithCapture(spawner, cmd, 'docker inspect (build container)').pipe(
			Effect.catch(() => Effect.succeed(null)),
		);
		if (captured === null || captured.exitCode !== 0) return null;
		const parts = captured.stdout.trim().split('|');
		if (parts.length !== 2) return null;
		const [runningStr, image] = parts as [string, string];
		if (image.length === 0) return null;
		return { running: runningStr === 'true', image };
	});

const dockerRm = (spawner: Spawner, name: string): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		yield* runWithCapture(
			spawner,
			ChildProcess.make('docker', ['rm', '-f', name]),
			'docker rm (build container)',
		).pipe(Effect.ignore);
	});

const dockerStart = (
	spawner: Spawner,
	name: string,
): Effect.Effect<void, SuiCliError> =>
	Effect.gen(function* () {
		const captured = yield* runWithCapture(
			spawner,
			ChildProcess.make('docker', ['start', name]),
			'docker start (build container)',
		);
		if (captured.exitCode !== 0) {
			return yield* Effect.fail(
				new SuiCliError({
					op: 'docker start (build container)',
					message: `failed to start build container '${name}': ${captured.stderr.trim() || captured.stdout.trim()}`,
					stdout: captured.stdout,
					stderr: captured.stderr,
					exitCode: captured.exitCode,
				}),
			);
		}
	});

// Bring up a sleeping container with the bind-mounts we want. Uses
// `sleep infinity` as the entrypoint so the container stays alive until
// we `docker rm -f` it on stack teardown. `--entrypoint` is intentional
// override of whatever the sui-image declares (`sui genesis` in the
// localnet flavor) — we want a quiet idle process, not the localnet
// bootstrap chatter.
const dockerRunDetached = (
	spawner: Spawner,
	name: string,
	imageTag: string,
	appDir: string,
	moveHome: string,
): Effect.Effect<void, SuiCliError> =>
	Effect.gen(function* () {
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
		const captured = yield* runWithCapture(
			spawner,
			ChildProcess.make('docker', args),
			'docker run -d (build container)',
		);
		if (captured.exitCode !== 0) {
			return yield* Effect.fail(
				new SuiCliError({
					op: 'docker run -d (build container)',
					message: `failed to start build container '${name}': ${captured.stderr.trim() || captured.stdout.trim()}`,
					stdout: captured.stdout,
					stderr: captured.stderr,
					exitCode: captured.exitCode,
				}),
			);
		}
	});

// Adopt-or-create the container. Three paths:
//   1. No container by that name → create fresh.
//   2. Container exists with the correct image:
//      a. running → adopt as-is.
//      b. stopped → `docker start` (leftover from a non-clean exit).
//   3. Container exists with a DIFFERENT image (e.g. user bumped
//      suiVersion) → rm -f and recreate so the build matches the
//      localnet's exact sui binary.
const ensureContainer = (
	spawner: Spawner,
	name: string,
	imageTag: string,
	appDir: string,
	moveHome: string,
): Effect.Effect<void, SuiCliError> =>
	Effect.gen(function* () {
		const current = yield* inspectContainer(spawner, name);
		if (current === null) {
			yield* dockerRunDetached(spawner, name, imageTag, appDir, moveHome);
			return;
		}
		if (current.image !== imageTag) {
			yield* dockerRm(spawner, name);
			yield* dockerRunDetached(spawner, name, imageTag, appDir, moveHome);
			return;
		}
		if (!current.running) {
			yield* dockerStart(spawner, name);
		}
	});

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
	const scrub =
		`find ${shellQuote(scrubRoot)} -maxdepth 4 -type f -name Move.lock ` +
		`-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
		`-exec awk -i inplace -f /tmp/scrub-move-lock.awk {} ';'`;
	const innerScript = [
		'set -e',
		stageAwk,
		scrub,
		`exec sui move build --path ${shellQuote(containerPath)} --dump-bytecode-as-base64 --with-unpublished-dependencies`,
	].join('; ');
	const cmd = ChildProcess.make('docker', [
		'exec',
		containerName,
		'sh',
		'-c',
		innerScript,
	]);
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
	]);
	return runWithCapture(spawner, cmd, 'docker exec (sui move summary)');
};

// Translate a host path to its container view through the `/host`
// bind-mount. Returns `undefined` when the path is outside `appDir`
// (which means the caller must fall back to a per-build `docker run`).
// Exported for direct unit-test coverage of the translation matrix —
// edge cases (Windows backslashes, app-dir trailing slash, parent
// references) live in the test file rather than in this module's body.
export const toContainerPath = (
	appDir: string,
	hostPath: string,
): string | undefined => {
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
					op: 'SuiBuildContainer acquire',
					message:
						'SuiBuildContainerLive requires SuiBuildImage to be provided (set by suiLocalnet).',
				}),
			);
		}
		const longLivedScope = yield* LongLivedScope;
		const currentScope = yield* Effect.scope;
		// Attach the cleanup finalizer to the LongLivedScope (when
		// provided) so the container survives per-cycle scope teardown.
		// Otherwise fall back to the current scope, matching standalone
		// callers' expectations.
		const cleanupScope = longLivedScope ?? currentScope;

		const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
		const moveHome = path.join(os.homedir(), '.move');
		const containerName = containerNameFor(identity);

		yield* ensureContainer(spawner, containerName, image.tag, appDir, moveHome);

		// `docker rm -f` is best-effort: a failure here (e.g. daemon
		// went away mid-shutdown) shouldn't fail the supervisor's
		// teardown sequence. The image gets reaped by the host docker's
		// own cleanup pass eventually.
		yield* Scope.addFinalizer(
			cleanupScope,
			dockerRm(spawner, containerName),
		);

		return {
			appDir,
			canExec: (hostPath: string) => toContainerPath(appDir, hostPath) !== undefined,
			runBuild: (hostPath: string) => {
				const containerPath = toContainerPath(appDir, hostPath);
				if (containerPath === undefined) {
					return Effect.fail(
						new SuiCliError({
							op: 'SuiBuildContainer.runBuild',
							message:
								`host path ${hostPath} is outside the bind-mounted app dir ${appDir}; ` +
								`caller must fall back to docker run --rm. Use canExec() to check first.`,
						}),
					);
				}
				return runBuildInside(spawner, containerName, containerPath);
			},
			runSummary: (hostPath: string) => {
				const containerPath = toContainerPath(appDir, hostPath);
				if (containerPath === undefined) {
					return Effect.fail(
						new SuiCliError({
							op: 'SuiBuildContainer.runSummary',
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
