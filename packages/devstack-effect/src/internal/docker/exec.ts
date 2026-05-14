// Command-execution wrappers — `exec` (run a command inside a running
// container), `commitContainer` (snapshot a container into a new image),
// and `runOneShot` (run-to-completion with TERM-then-KILL escalation).

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer } from 'effect/Scope';
import { DockerError } from '../../primitives/errors.js';
import {
	captureStreams,
	decodeStream,
	dockerError,
	generateContainerName,
	runCapturingOrFail,
	type DockerExecResult,
} from './core.js';

// Re-export the result shape so consumers can `Docker.DockerExecResult`
// if they ever annotate the type explicitly.
export type { DockerExecResult };

// -----------------------------------------------------------------------------
// Exec — run a command inside a running container
// -----------------------------------------------------------------------------

export const exec = (
	containerId: string,
	command: string,
	args: ReadonlyArray<string> = [],
): Effect.Effect<DockerExecResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.container': containerId, 'docker.cmd': command });

		const cmd = ChildProcess.make('docker', ['exec', containerId, command, ...args]);
		return yield* captureStreams(spawner, cmd, 'docker exec');
	}).pipe(Effect.withSpan('Docker.exec'));

// -----------------------------------------------------------------------------
// commitContainer — snapshot a running container into a new image
// -----------------------------------------------------------------------------

export interface DockerCommitResult {
	readonly digest: string;
}

// `docker commit <containerId> <imageName>` freezes the container's RW layer
// into a new image. We then `docker image inspect` to surface the resulting
// digest (same pattern as `pull` / `build`) so callers can record what they
// captured.
export const commitContainer = (
	containerId: string,
	imageName: string,
): Effect.Effect<DockerCommitResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'commit',
			'docker.container': containerId,
			'docker.image': imageName,
		});

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['commit', containerId, imageName]),
			'docker commit',
		);

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', imageName]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker commit',
					message: `docker image inspect returned empty digest for ${imageName}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.commitContainer'));

// -----------------------------------------------------------------------------
// runOneShot — run to completion, capture stdout
// -----------------------------------------------------------------------------

export interface DockerOneShotOptions {
	readonly name?: string;
	readonly image: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly network?: string;
	/** Override the image's `ENTRYPOINT`. Maps to `docker run --entrypoint`.
	 * Use for images with a default `ENTRYPOINT` you want to bypass (e.g.
	 * an image whose default is the long-running daemon, but you want to
	 * run a CLI co-installed in the same image for a one-shot setup). */
	readonly entrypoint?: string;
	/**
	 * Wall-clock budget for the entire `docker run` invocation. On expiry the
	 * scope closes and the spawner's finalizer SIGTERMs the foreground
	 * `docker` CLI, then SIGKILLs after `gracePeriodMs` if it hasn't exited.
	 * We additionally fire a best-effort `docker rm -f <name>` so a workload
	 * left behind by a racing SIGKILL still gets torn down — `--rm` cleanup
	 * isn't guaranteed if the foreground CLI dies before it runs. Defaults
	 * to 10 minutes, matching the v3 runner.
	 */
	readonly timeoutMs?: number;
	/**
	 * Grace period between SIGTERM and the fallback SIGKILL when the scope
	 * closes (either because the timeout fired or because an outer scope was
	 * interrupted). Defaults to 5_000 ms, matching v3.
	 */
	readonly gracePeriodMs?: number;
}

export interface DockerOneShotResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const DEFAULT_ONE_SHOT_TIMEOUT_MS = 600_000;
const DEFAULT_ONE_SHOT_GRACE_PERIOD_MS = 5_000;

export const runOneShot = (
	opts: DockerOneShotOptions,
): Effect.Effect<DockerOneShotResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const name = opts.name ?? generateContainerName();
		const args: Array<string> = ['run', '--rm', '--name', name];
		if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
		if (opts.network !== undefined) args.push('--network', opts.network);
		for (const [k, v] of Object.entries(opts.env ?? {})) {
			args.push('-e', `${k}=${v}`);
		}
		for (const { host, container } of opts.mounts ?? []) {
			args.push('-v', `${host}:${container}`);
		}
		args.push(opts.image);
		for (const a of opts.args ?? []) args.push(a);

		const timeoutMs = opts.timeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS;
		const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_ONE_SHOT_GRACE_PERIOD_MS;

		yield* Effect.annotateCurrentSpan({
			'docker.op': 'runOneShot',
			'docker.name': name,
			'docker.timeoutMs': timeoutMs,
			'docker.gracePeriodMs': gracePeriodMs,
		});

		// Wire TERM-then-KILL escalation onto the command itself: the
		// spawner's scope finalizer reads `killSignal` / `forceKillAfter` to
		// decide how to tear down the child when the inner `Effect.scoped`
		// closes (because we resolved normally, because the timeout below
		// interrupted us, or because an outer scope closed). We also stage
		// a `docker rm -f <name>` finalizer so a daemon-side container that
		// outlived a SIGKILL'd foreground CLI still gets reaped.
		const op = 'docker run (one-shot)';
		const cmd = ChildProcess.make('docker', args, {
			killSignal: 'SIGTERM',
			forceKillAfter: `${gracePeriodMs} millis`,
		});

		const work = Effect.scoped(
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				yield* addFinalizer(
					scope,
					spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', name])).pipe(Effect.ignore),
				);
				const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(dockerError(op)));
				const [stdoutText, stderrText, code] = yield* Effect.all(
					[
						decodeStream(handle.stdout).pipe(Effect.mapError(dockerError(op))),
						decodeStream(handle.stderr).pipe(Effect.mapError(dockerError(op))),
						handle.exitCode.pipe(Effect.mapError(dockerError(op))),
					],
					{ concurrency: 'unbounded' },
				);
				return { exitCode: code as number, stdout: stdoutText, stderr: stderrText };
			}),
		);

		return yield* work.pipe(
			Effect.timeoutOrElse({
				duration: `${timeoutMs} millis`,
				orElse: () =>
					Effect.fail(
						new DockerError({
							op,
							message: `docker run (one-shot) '${name}' timed out after ${timeoutMs}ms`,
						}),
					),
			}),
		);
	}).pipe(Effect.withSpan('Docker.runOneShot'));
