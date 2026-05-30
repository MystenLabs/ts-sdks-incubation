// Thin `docker` CLI wrapper.
//
// Every subprocess invocation flows through the L0 subprocess-capture
// primitive (one capture function, one error class). This module owns:
//
//   - The argv constructor (`dockerArgv`).
//   - The `DOCKER_HOST` env passthrough (architecture §7: one-daemon
//     assumption, env override supported).
//   - Two convenience verbs: `run` (capture-with-success-or-fail-by-exit)
//     and `runOk` (capture, return CaptureResult regardless of exit so
//     the caller can classify stderr). NO docker compose anywhere.
//
// No service names appear here. No stderr-pattern classification —
// that's in `wrap.ts`. This file is mechanical argv + spawn.

import { Context, Effect, Layer } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner } from 'effect/unstable/process';

import {
	capture,
	type CaptureError,
	type CaptureOptions,
	type CaptureResult,
} from '../../substrate/runtime/observability/subprocess-capture.ts';

// -----------------------------------------------------------------------------
// Daemon-host configuration
// -----------------------------------------------------------------------------

/** Optional `DOCKER_HOST` override. When absent we let the docker CLI
 *  resolve its default socket (Unix: `/var/run/docker.sock`; macOS
 *  Desktop: `unix:///var/run/docker.sock`; remote daemon if the user
 *  set `DOCKER_HOST` in their own env). */
export interface DockerHostShape {
	readonly dockerHost?: string;
	/** Optional explicit binary path (default `docker`). Tests use
	 *  this to point at a stub; otherwise we resolve via PATH. */
	readonly bin?: string;
}

export class DockerHost extends Context.Service<DockerHost, DockerHostShape>()(
	'@devstack/runtime-docker/DockerHost',
) {}

export const layerDockerHostDefault: Layer.Layer<DockerHost> = Layer.succeed(DockerHost)({});

export const layerDockerHost = (shape: DockerHostShape): Layer.Layer<DockerHost> =>
	Layer.succeed(DockerHost)(shape);

// -----------------------------------------------------------------------------
// Spawner injection
// -----------------------------------------------------------------------------

/** A spawner service exposing `spawn`. Held as a service so tests can
 *  inject a stub. In production this is `ChildProcessSpawner.make()`
 *  from `effect/unstable/process` (provided via `@effect/platform-node`). */
export class DockerSpawner extends Context.Service<
	DockerSpawner,
	ReturnType<typeof ChildProcessSpawner.make>
>()('@devstack/runtime-docker/DockerSpawner') {}

// -----------------------------------------------------------------------------
// Argv construction
// -----------------------------------------------------------------------------

const buildEnv = (host: DockerHostShape): Record<string, string> => {
	const env: Record<string, string> = {};
	if (host.dockerHost !== undefined) env.DOCKER_HOST = host.dockerHost;
	return env;
};

/** Grace period between the scope-close SIGTERM and the escalation
 *  SIGKILL. Without `forceKillAfter` the Node spawner sends ONE SIGTERM
 *  on scope close and then waits indefinitely for the child to die — so
 *  a timeout-interrupt (see `exec.ts` / `dockerRunOneShot` `Effect.timeout`)
 *  blocks on scope-close if the docker CLI ignores SIGTERM. A few
 *  seconds lets a well-behaved CLI flush and exit cleanly before we
 *  force-kill the wedged case. */
const KILL_GRACE = '5 seconds';

/** Build a `ChildProcess.Command` from `(verb, ...args)`. The verb is
 *  separate so observability span attributes can pin the
 *  high-cardinality `args` separately from the `devstack.op` tag.
 *
 *  `forceKillAfter` makes scope-close termination escalate
 *  SIGTERM→SIGKILL so an interrupt (timeout) can't wedge on a docker CLI
 *  that ignores SIGTERM. */
export const dockerCommand = (
	host: DockerHostShape,
	verb: string,
	args: ReadonlyArray<string>,
	overrideEnv: Readonly<Record<string, string>> = {},
): ChildProcess.Command => {
	const bin = host.bin ?? 'docker';
	const env = { ...buildEnv(host), ...overrideEnv };
	return ChildProcess.make(bin, [verb, ...args], {
		env,
		extendEnv: true,
		forceKillAfter: KILL_GRACE,
	});
};

// -----------------------------------------------------------------------------
// Capture verbs
// -----------------------------------------------------------------------------

/** Capture a docker invocation, fail on non-zero exit. Use when any
 *  non-zero exit is a failure case (most write operations). */
export const dockerRun = (
	verb: string,
	args: ReadonlyArray<string>,
	opts?: Omit<CaptureOptions, 'op' | 'nonZeroIsFailure'>,
): Effect.Effect<CaptureResult, CaptureError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const host = yield* DockerHost;
		const spawner = yield* DockerSpawner;
		return yield* capture(spawner, dockerCommand(host, verb, args), {
			...opts,
			op: `docker.${verb}`,
			nonZeroIsFailure: true,
		});
	});

/** Capture a docker invocation, return the `CaptureResult` regardless
 *  of exit. Use when the caller classifies stderr or wants the exit
 *  code (lifecycle state machine, inventory). */
export const dockerRunOk = (
	verb: string,
	args: ReadonlyArray<string>,
	opts?: Omit<CaptureOptions, 'op' | 'nonZeroIsFailure'>,
): Effect.Effect<CaptureResult, CaptureError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const host = yield* DockerHost;
		const spawner = yield* DockerSpawner;
		return yield* capture(spawner, dockerCommand(host, verb, args), {
			...opts,
			op: `docker.${verb}`,
			nonZeroIsFailure: false,
		});
	});
