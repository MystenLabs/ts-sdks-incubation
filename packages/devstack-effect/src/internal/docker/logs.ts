// `Docker.followLogs` — stream `docker logs -f <id>` as decoded lines
// so primitives can wire a log-pattern readyProbe against a detached
// container.

import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

// Follow a running container's combined stdout/stderr as a line stream. Used
// by primitives that wire a `log` readyProbe against a detached container —
// `docker run -d` doesn't give us a stdout stream directly, so we shell out
// to `docker logs -f` and decode the bytes. Errors from the underlying
// spawner are dropped into defects: a probe whose log feed has died can't
// recover, so surfacing it as a typed error wouldn't help the caller.
export const followLogs = (
	containerId: string,
): Stream.Stream<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make('docker', ['logs', '-f', containerId]);
			// Spawn failure / stdout pipe failure go to defects — a probe
			// whose log feed died can't recover, so a typed error wouldn't
			// help the caller.
			const handle = yield* Effect.orDie(spawner.spawn(cmd));
			return Stream.splitLines(Stream.decodeText(Stream.orDie(handle.stdout)));
		}),
	);
