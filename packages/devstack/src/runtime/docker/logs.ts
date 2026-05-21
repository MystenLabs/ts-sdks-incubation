// `docker logs --follow` as an Effect Stream.
//
// Architecture invariant: per-line `Stream<string, …>` so consumers
// can filter / promote levels / dedupe followers across hot-restart
// cycles via the L1 per-line sink.
//
// We DON'T solve the process-global follower-dedupe problem here; the
// supervisor's per-container-key registry is where dedupe lives.
// This stream is the raw substrate.

import { Effect, Stream } from 'effect';

import { DockerHost, DockerSpawner } from './client.ts';
import { DaemonUnreachable, type DockerRuntimeError } from './errors.ts';
import { dockerCommand } from './client.ts';

export interface FollowLogsOptions {
	readonly since?: string;
	readonly tail?: number;
}

/** `docker logs --follow --timestamps <id>` projected to a per-line
 *  Stream. Combined stdout+stderr (docker writes both to the same
 *  follow stream).
 *
 *  IMPORTANT: the stream completes when the container exits (docker
 *  closes the pipe). Consumers that want to re-follow after a restart
 *  must re-call this. */
export const followLogs = (
	containerNameOrId: string,
	opts: FollowLogsOptions = {},
): Stream.Stream<string, DockerRuntimeError, DockerHost | DockerSpawner> => {
	const args: Array<string> = ['--follow', '--timestamps'];
	if (opts.since !== undefined) args.push('--since', opts.since);
	if (opts.tail !== undefined) args.push('--tail', String(opts.tail));
	args.push(containerNameOrId);
	const mapSpawnError = (cause: unknown): DockerRuntimeError =>
		new DaemonUnreachable({ op: 'docker.logs', detail: 'logs follow stream failed', cause });
	return Stream.unwrap(
		Effect.gen(function* () {
			const host = yield* DockerHost;
			const spawner = yield* DockerSpawner;
			const cmd = dockerCommand(host, 'logs', args);
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnError));
			// Merge stdout + stderr so caller sees the unified follow stream;
			// docker prefixes each line with its source via --timestamps.
			const lineStream = Stream.merge(handle.stdout, handle.stderr).pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.mapError(mapSpawnError),
			);
			return lineStream;
		}),
	);
};

/** Best-effort log tail for error enrichment. Returns the last
 *  `tail` lines as a single string; on any failure returns empty. */
export const logTail = (
	containerNameOrId: string,
	tail: number = 50,
): Effect.Effect<string, never, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const host = yield* DockerHost;
		const spawner = yield* DockerSpawner;
		const cmd = dockerCommand(host, 'logs', ['--tail', String(tail), containerNameOrId]);
		const res = yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* spawner.spawn(cmd);
				const [out, err] = yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
					],
					{ concurrency: 'unbounded' },
				);
				return `${out}\n${err}`.trim();
			}),
		).pipe(Effect.catch(() => Effect.succeed('')));
		return res;
	}).pipe(Effect.withSpan('runtime.docker.logs.tail'));
