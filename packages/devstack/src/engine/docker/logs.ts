// Docker log helpers:
//
//   `followLogs(containerId)` — stream `docker logs -f` lines for a
//     long-running container. Used to drive `log`-pattern readyProbes.
//
//   `dockerLogsTail(name, n)` — one-shot `docker logs --tail N`. Always
//     resolves; swallows all errors into `''` so call sites can append
//     unconditionally in failure paths.
//
//   `dockerWait(name)` — block on `docker wait`; resolves to the
//     container's exit code when it exits.
//
//   `awaitContainerReady({ name, probe })` — race a ready-probe against
//     `dockerWait`. If the container exits before the probe succeeds,
//     fetch its log tail and fail with the logs included. Without this,
//     a crashed container surfaces as a generic "timed out" after the
//     probe's full wall-clock budget and the user has to manually run
//     `docker logs` to find out why.

import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { DockerError } from '../../engine/errors.js';
import { awaitReady, ReadyProbeError, type ReadyProbe } from '../ready-probe.js';
import { dockerError } from './core.js';

// Follow a running container's combined stdout/stderr as a line stream.
export const followLogs = (
	containerId: string,
): Stream.Stream<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make('docker', ['logs', '-f', containerId]);
			// Spawn / pipe failure go to defects — a probe whose log feed
			// died can't recover, so a typed error wouldn't help the caller.
			const handle = yield* Effect.orDie(spawner.spawn(cmd));
			return Stream.splitLines(Stream.decodeText(Stream.orDie(handle.stdout)));
		}),
	);

/**
 * Best-effort tail of a container's combined stdout+stderr. Returns
 * the empty string on any failure (no container, daemon down, parse
 * error, …). Intended for enriching error messages — callers append
 * the result unconditionally without any further error handling.
 */
export const dockerLogsTail = (
	containerName: string,
	lines = 100,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make('docker', [
				'logs',
				'--tail',
				String(lines),
				containerName,
			]);
			const handle = yield* spawner.spawn(cmd);
			const [stdout, stderr] = yield* Effect.all(
				[
					Stream.decodeText(Stream.orDie(handle.stdout)).pipe(Stream.mkString),
					Stream.decodeText(Stream.orDie(handle.stderr)).pipe(Stream.mkString),
				],
				{ concurrency: 'unbounded' },
			);
			yield* handle.exitCode;
			return [stdout, stderr].filter((s) => s.length > 0).join('\n');
		}),
	).pipe(Effect.orElseSucceed(() => ''));

/**
 * Block until `docker wait <name>` returns; resolves to the container's
 * exit code. Fails (typed `DockerError`) if `docker wait` itself errors.
 */
export const dockerWait = (
	containerName: string,
): Effect.Effect<number, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make('docker', ['wait', containerName]);
			const handle = yield* spawner
				.spawn(cmd)
				.pipe(Effect.mapError(dockerError('docker wait')));
			const stdout = yield* Stream.decodeText(Stream.orDie(handle.stdout)).pipe(
				Stream.mkString,
			);
			const code = yield* handle.exitCode.pipe(
				Effect.mapError(dockerError('docker wait')),
			);
			if (code !== 0) {
				return yield* Effect.fail(
					new DockerError({
						op: 'docker wait',
						message: `docker wait ${containerName} exit ${code}`,
					}),
				);
			}
			const parsed = Number.parseInt(stdout.trim(), 10);
			return Number.isFinite(parsed) ? parsed : -1;
		}),
	);

/**
 * Race a ready-probe against the container's exit. If the container
 * exits before the probe succeeds, fetch its log tail and fail with a
 * `ReadyProbeError` whose `detail` carries the docker-logs output. On
 * a plain probe timeout (no exit, no success), also fetches logs and
 * appends them to the resulting `ReadyProbeError`.
 */
export const awaitContainerReady = (opts: {
	readonly containerName: string;
	readonly probe: ReadyProbe;
	/** Lines of `docker logs --tail` to include on failure. Default 100. */
	readonly logTailLines?: number;
}): Effect.Effect<void, ReadyProbeError, ChildProcessSpawner.ChildProcessSpawner> => {
	const lines = opts.logTailLines ?? 100;
	const probeBranch = awaitReady(opts.probe).pipe(Effect.map(() => 'ready' as const));
	const exitBranch = dockerWait(opts.containerName).pipe(
		Effect.flatMap((code) =>
			dockerLogsTail(opts.containerName, lines).pipe(
				Effect.flatMap((tail) =>
					Effect.fail(
						new ReadyProbeError({
							probe: opts.probe,
							message: `container ${opts.containerName} exited (code=${code}) before ready probe succeeded`,
							detail: tail.length > 0 ? tail : undefined,
						}),
					),
				),
			),
		),
		Effect.catchTag('DockerError', () =>
			// `docker wait` itself failed — degrade gracefully, let the
			// probe branch take the wheel.
			Effect.never as Effect.Effect<never, ReadyProbeError>,
		),
	);
	return Effect.raceAll([probeBranch, exitBranch]).pipe(
		Effect.map(() => undefined),
		Effect.catchTag('ReadyProbeError', (err) =>
			err.detail !== undefined
				? Effect.fail(err)
				: dockerLogsTail(opts.containerName, lines).pipe(
						Effect.flatMap((tail) =>
							Effect.fail(
								new ReadyProbeError({
									probe: err.probe,
									message: err.message,
									cause: err.cause,
									detail: tail.length > 0 ? tail : undefined,
								}),
							),
						),
					),
		),
	);
};
