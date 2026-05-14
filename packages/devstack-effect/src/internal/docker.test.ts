// Reuse-if-healthy behavior for `Docker.run`. The unit under test is the
// inspect-then-decide branch added so `r` (hot restart) doesn't tear down
// reusable docker containers. We stub the spawner so each `docker inspect`
// / `docker rm` / `docker run` returns a canned response, then assert the
// recorder shows the expected argv ordering (or absence) for each scenario.

import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import * as Docker from './docker.js';
import { Identity } from './identity.js';

interface SpawnRecord {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
}

const FAKE_CONTAINER_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
const EXISTING_CONTAINER_ID = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';

// Build a spawner whose `docker inspect <name>` returns a configurable
// shape (or "no such container"). Every other docker invocation returns
// success with synthetic output so finalizers + the run path can complete.
interface InspectResponse {
	readonly running: boolean;
	readonly image: string;
	readonly containerId: string;
}

const makeSpawnerLayer = (
	recorder: Array<SpawnRecord>,
	inspectResponse: InspectResponse | null,
) => {
	const stdoutFor = (args: ReadonlyArray<string>): { text: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			if (inspectResponse === null) {
				return { text: '', exitCode: 1 };
			}
			const { running, image, containerId } = inspectResponse;
			return { text: `${running}|${image}|${containerId}\n`, exitCode: 0 };
		}
		if (args[0] === 'run') return { text: `${FAKE_CONTAINER_ID}\n`, exitCode: 0 };
		if (args[0] === 'ps') return { text: '', exitCode: 0 };
		return { text: '', exitCode: 0 };
	};

	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected piped command'));
		}
		recorder.push({ command: command.command, args: [...command.args] });
		const { text, exitCode } = stdoutFor(command.args);
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(1234),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout: Stream.succeed(new TextEncoder().encode(text)),
			stderr: Stream.empty,
			all: Stream.succeed(new TextEncoder().encode(text)),
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};

	const impl = ChildProcessSpawner.make(spawn);
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, impl);
};

const identityLayer = Layer.succeed(Identity, { app: 'testapp', stack: 'main' });

describe('Docker.run reuse-if-healthy', () => {
	it.effect(
		'adopts an existing healthy container with the same image (skips docker run)',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				const spawnerLayer = makeSpawnerLayer(recorder, {
					running: true,
					image,
					containerId: EXISTING_CONTAINER_ID,
				});

				const result = yield* Docker.run({ name: 'sui.localnet', image }).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				expect(result.containerId).toBe(EXISTING_CONTAINER_ID);
				expect(recorder.some((r) => r.args[0] === 'inspect')).toBe(true);
				expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
			}),
	);

	it.effect(
		'recreates when an existing container is running a DIFFERENT image',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:2.0.0';
				const spawnerLayer = makeSpawnerLayer(recorder, {
					running: true,
					image: 'mystenlabs/sui-tools:1.0.0',
					containerId: EXISTING_CONTAINER_ID,
				});

				const result = yield* Docker.run({ name: 'sui.localnet', image }).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				expect(result.containerId).toBe(FAKE_CONTAINER_ID);
				const runIdx = recorder.findIndex((r) => r.args[0] === 'run');
				const psIdx = recorder.findIndex((r) => r.args[0] === 'ps');
				expect(runIdx).toBeGreaterThanOrEqual(0);
				expect(psIdx).toBeGreaterThanOrEqual(0);
				expect(psIdx).toBeLessThan(runIdx);
			}),
	);

	it.effect(
		'recreates when an existing container exists but is NOT running',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				const spawnerLayer = makeSpawnerLayer(recorder, {
					running: false,
					image,
					containerId: EXISTING_CONTAINER_ID,
				});

				const result = yield* Docker.run({ name: 'sui.localnet', image }).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				expect(result.containerId).toBe(FAKE_CONTAINER_ID);
				expect(recorder.some((r) => r.args[0] === 'run')).toBe(true);
			}),
	);

	it.effect(
		'creates a new container when nothing matches the requested name',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				const spawnerLayer = makeSpawnerLayer(recorder, null);

				const result = yield* Docker.run({ name: 'sui.localnet', image }).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				expect(result.containerId).toBe(FAKE_CONTAINER_ID);
				expect(recorder.some((r) => r.args[0] === 'run')).toBe(true);
			}),
	);
});

