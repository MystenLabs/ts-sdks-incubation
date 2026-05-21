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
	'@devstack-rewrite/runtime-docker/DockerHost',
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
>()('@devstack-rewrite/runtime-docker/DockerSpawner') {}

// -----------------------------------------------------------------------------
// Argv construction
// -----------------------------------------------------------------------------

const buildEnv = (host: DockerHostShape): Record<string, string> => {
	const env: Record<string, string> = {};
	if (host.dockerHost !== undefined) env.DOCKER_HOST = host.dockerHost;
	return env;
};

/** Build a `ChildProcess.Command` from `(verb, ...args)`. The verb is
 *  separate so observability span attributes can pin the
 *  high-cardinality `args` separately from the `devstack.op` tag. */
export const dockerCommand = (
	host: DockerHostShape,
	verb: string,
	args: ReadonlyArray<string>,
	overrideEnv: Readonly<Record<string, string>> = {},
): ChildProcess.Command => {
	const bin = host.bin ?? 'docker';
	const env = { ...buildEnv(host), ...overrideEnv };
	return ChildProcess.make(bin, [verb, ...args], { env, extendEnv: true });
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
