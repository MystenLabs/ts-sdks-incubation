// Per-app long-lived Move build container.
//
// Architecture Decision §5: the build container is PER-APP, NOT
// per-stack. Two parallel stacks of the same app share the same
// sleeper container — their concurrent Move builds serialise on
// docker exec queueing. This is intentional: dep-cache reuse
// across stacks outweighs the serialisation cost.
//
// Adopt-or-create state machine is delegated to the substrate's
// `ContainerRuntime.ensureContainer` with `recreate: 'never'` —
// daemon outages must fail loudly, not silently churn (distilled
// doc S6: "MUST reject the helper's auto-recreate-on-resume-failed
// path").
//
// Cross-process safety: the host-wide advisory lock is owned by
// THIS module. The lock is held inside the build call (NOT at the
// docker-exec layer), because three distinct execution paths (host
// CLI, fresh `docker run --rm`, container exec) all need
// protection. Lock path: `~/.devstack/locks/sui-move-build-<repoHash>.lock`.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Effect, type Scope } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
	ImageRef,
} from '../../contracts/container-runtime.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import {
	ensureManagedContainer,
	PER_APP_SHARED_STACK,
} from '../../substrate/runtime/managed-container.ts';
import { containerInnerScript } from '../../substrate/runtime/sui-move-build/index.ts';
import { suiCliError, suiPluginError, type SuiCliError, type SuiPluginError } from './errors.ts';

/** Default move-build lock timeout — five minutes, matching the
 *  distilled-doc invariant. The lock is held during the build
 *  body only; long-running stages never share it. */
export const MOVE_BUILD_LOCK_TIMEOUT_MS = 5 * 60_000;

const BUILD_CONTAINER_STOP_GRACE_SECONDS = 2;
const BUILD_CONTAINER_KEEPALIVE_COMMAND = [
	'child=;',
	'trap \'[ -z "$child" ] || kill "$child" 2>/dev/null || true; exit 0\' INT TERM;',
	'sleep infinity & child=$!;',
	'wait "$child"',
].join(' ');

/** Per-app container name. The substrate's `pluginKey('sui-build')`
 *  + the app discriminator combine to a stable name; the container
 *  intentionally omits the stack/network suffix so two stacks of
 *  the same app share. */
export const containerNameForApp = (app: string): string => `devstack-${app}-build`;

const expandHome = (path: string): string =>
	path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

const repoHashForLock = (appDir: string): string =>
	createHash('sha256').update(resolve(appDir)).digest('hex').slice(0, 16);

export const moveBuildLockPathFor = (appDir: string, moveHome: string): string => {
	const moveHomeRoot = dirname(resolve(expandHome(moveHome)));
	return join(moveHomeRoot, '.devstack', 'locks', `sui-move-build-${repoHashForLock(appDir)}.lock`);
};

/** Build-container handle returned to plugin internals (the
 *  cli-driver dispatches into this). */
export interface ChainBuildContainer {
	readonly handle: ContainerHandle;
	/** Translate a host-absolute path into a container-bind path.
	 *  Returns null when the host path escapes the bind-mounted app
	 *  dir — callers MUST fall back to `docker run --rm` in that
	 *  case (distilled-doc: "Build container path translation MUST
	 *  refuse paths outside the bind-mounted app dir"). */
	readonly toContainerPath: (hostPath: string) => string | null;
	/** Run a sui-cli capture inside the container. Acquires the
	 *  host-wide move-build lock before invoking docker-exec. */
	readonly runBuild: (
		hostPackagePath: string,
	) => Effect.Effect<
		{ readonly exitCode: number; readonly stdout: string; readonly stderr: string },
		SuiCliError,
		Scope.Scope
	>;
	/** Run a codegen-style "summary" build inside the container.
	 *  Same wire shape as runBuild; the codegen plugin consumes
	 *  this via the cross-service seam. */
	readonly runSummary: (
		hostPackagePath: string,
	) => Effect.Effect<
		{ readonly exitCode: number; readonly stdout: string; readonly stderr: string },
		SuiCliError,
		Scope.Scope
	>;
}

/** Spec passed to `ContainerRuntime.ensureContainer` for the
 *  per-app sleeper. Image is content-hashed; labels carry the
 *  app discriminator so `inspectByLabels` finds it across stacks. */
export interface ChainBuildContainerSpec {
	readonly app: string;
	readonly stack: string;
	readonly appDir: string;
	readonly moveHome: string;
	readonly image: ImageRef;
}

/**
 * Acquire (or adopt) the per-app build container. Returns a
 * `ChainBuildContainer` handle scoped to the caller's Scope.
 *
 * The build call holds the host-wide move-build lock for the docker
 * exec body. The lock uses the substrate's PID + start-time stale
 * holder reclaim path, so a crashed peer cannot wedge future builds.
 */
export const acquireChainBuildContainer = (
	runtime: ContainerRuntime,
	spec: ChainBuildContainerSpec,
): Effect.Effect<ChainBuildContainer, ContainerRuntimeError | SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// The sleeper shell traps Docker's stop signal so scope-close
		// does not wait for Docker's default SIGKILL escalation path.
		// This also overrides the sui image's default `start
		// --with-faucet=...` entrypoint so the validator binary doesn't
		// run genesis inside a build container.
		// The appDir is bind-mounted at `/workspace`, with the user's
		// `~/.move` bind-mounted at `/root/.move` so the content-addressed
		// dep cache (`~/.move/git/<repo>@<sha>/…`) persists across builds.
		const ensureSpec: EnsureContainerSpec = {
			name: containerNameForApp(spec.app),
			image: spec.image,
			labels: {
				app: spec.app,
				// Intentionally pin stack to a sentinel — see comment
				// above; this is per-app, not per-stack.
				stack: PER_APP_SHARED_STACK,
				plugin: 'sui',
				role: 'build',
			},
			recreate: 'never',
			entrypoint: 'sh',
			command: ['-c', BUILD_CONTAINER_KEEPALIVE_COMMAND],
			stopGraceSeconds: BUILD_CONTAINER_STOP_GRACE_SECONDS,
			mounts: [
				{ source: spec.appDir, target: '/workspace' },
				{ source: spec.moveHome, target: '/root/.move' },
			],
		};
		const { labels, ...containerSpec } = ensureSpec;
		const handle = yield* ensureManagedContainer({
			runtime,
			labels,
			spec: containerSpec,
			mapError: (cause) => cause,
		});

		const toContainerPath = (hostPath: string): string | null => {
			// The runtime adapter bind-mounts `spec.appDir` at
			// `/workspace`. A host path outside that bind is not
			// accessible to the container.
			if (!hostPath.startsWith(spec.appDir)) return null;
			const rel = hostPath.slice(spec.appDir.length).replace(/^\/+/, '');
			return rel === '' ? '/workspace' : `/workspace/${rel}`;
		};
		const moveBuildLockPath = moveBuildLockPathFor(spec.appDir, spec.moveHome);

		const runInContainer = (
			op: 'build' | 'summary',
			hostPackagePath: string,
		): Effect.Effect<
			{ readonly exitCode: number; readonly stdout: string; readonly stderr: string },
			SuiCliError,
			Scope.Scope
		> =>
			Effect.gen(function* () {
				const containerPath = toContainerPath(hostPackagePath);
				if (containerPath === null) {
					return yield* Effect.fail(
						suiCliError(op, {
							cause: new Error(
								`chain-build-container: host path ${hostPackagePath} escapes appDir bind (${spec.appDir}); ` +
									`caller MUST fall back to docker run --rm`,
							),
						}),
					);
				}
				// The package's container path = `/workspace/<basename>`;
				// containerInnerScript stages the awk scrub then exec-s
				// `sui move build --path /workspace/<pkgName>` with the
				// invariant flag set.
				const pkgName = containerPath.replace(/^\/workspace\//, '').replace(/^\/+|\/+$/g, '');
				const inner = containerInnerScript(pkgName);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(moveBuildLockPath, MOVE_BUILD_LOCK_TIMEOUT_MS).pipe(
							Effect.mapError(
								(cause): SuiCliError =>
									suiCliError(op, {
										cause: new Error(`move-build lock acquire failed: ${cause._tag}`, { cause }),
									}),
							),
						);
						return yield* runtime.exec(handle, ['sh', '-c', inner]).pipe(
							Effect.mapError(
								(cause): SuiCliError =>
									suiCliError(op, {
										cause: new Error(`runtime.exec failed: ${cause.reason}: ${cause.detail}`),
									}),
							),
						);
					}),
				);
				return result;
			});

		const runBuild = (hostPackagePath: string) => runInContainer('build', hostPackagePath);
		const runSummary = (hostPackagePath: string) => runInContainer('summary', hostPackagePath);

		return { handle, toContainerPath, runBuild, runSummary };
	}).pipe(
		Effect.mapError((cause) =>
			isContainerRuntimeError(cause)
				? cause
				: suiPluginError('image-build', 'chain-build-container.acquire failed', cause),
		),
	);

const isContainerRuntimeError = (e: unknown): e is ContainerRuntimeError =>
	typeof e === 'object' && e !== null && (e as { _tag?: string })._tag === 'ContainerRuntimeError';
