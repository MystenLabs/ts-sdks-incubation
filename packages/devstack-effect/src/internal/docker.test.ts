// Reuse-if-healthy behavior for `Docker.run`. The unit under test is the
// inspect-then-decide branch added so `r` (hot restart) doesn't tear down
// reusable docker containers. We stub the spawner so each `docker inspect`
// / `docker rm` / `docker run` returns a canned response, then assert the
// recorder shows the expected argv ordering (or absence) for each scenario.
//
// The bottom block covers the pure `decideRunAction` decision function
// directly — five matrix branches plus the runtime "resume failed →
// recreate" promotion (the latter via an integration test that fails
// `docker start` and asserts `docker run` is called WITHOUT the caller's
// original host ports — see `Docker.run resume-fallback re-allocates`).

import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import * as Docker from './docker.js';
import { decideRunAction } from './docker/core.js';
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

interface SpawnerLayerOpts {
	/** Exit code to return for `docker start`. Defaults to 0 (success). */
	readonly startExitCode?: number;
	/**
	 * JSON for `.HostConfig.PortBindings` returned by the second
	 * `docker inspect <id> --format {{json .HostConfig.PortBindings}}`
	 * call (used on the resume / recreate path to read the actual
	 * host-port binding). Defaults to `null` (empty bindings).
	 */
	readonly portBindingsJson?: string;
}

const makeSpawnerLayer = (
	recorder: Array<SpawnRecord>,
	inspectResponse: InspectResponse | null,
	options: SpawnerLayerOpts = {},
) => {
	const stdoutFor = (args: ReadonlyArray<string>): { text: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			// Distinguish the name-inspect (returns running|image|id) from
			// the host-ports inspect (returns JSON for PortBindings) by
			// the `--format` argument shape.
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt !== undefined && fmt.includes('PortBindings')) {
				return { text: `${options.portBindingsJson ?? 'null'}\n`, exitCode: 0 };
			}
			if (inspectResponse === null) {
				return { text: '', exitCode: 1 };
			}
			const { running, image, containerId } = inspectResponse;
			return { text: `${running}|${image}|${containerId}\n`, exitCode: 0 };
		}
		if (args[0] === 'start') {
			return { text: '', exitCode: options.startExitCode ?? 0 };
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

const identityLayer = Layer.succeed(Identity, {
	app: 'testapp',
	stack: 'main',
	network: 'localnet',
});

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
		'resumes a stopped container with matching image via `docker start` instead of re-running',
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

				// The stopped container's on-disk state is preserved by
				// resuming it rather than recreating: ~1s start vs cold
				// genesis. Adopts the existing container id; never calls
				// `docker run`; does call `docker start <id>`.
				expect(result.containerId).toBe(EXISTING_CONTAINER_ID);
				expect(result.reused).toBe(true);
				expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
				expect(
					recorder.some(
						(r) => r.args[0] === 'start' && r.args[1] === EXISTING_CONTAINER_ID,
					),
				).toBe(true);
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

// -----------------------------------------------------------------------------
// `decideRunAction` — pure five-state matrix for `Docker.run`
// -----------------------------------------------------------------------------

describe('decideRunAction', () => {
	const IMAGE = 'mystenlabs/sui-tools:1.0.0';
	const OTHER_IMAGE = 'mystenlabs/sui-tools:2.0.0';

	it('returns `fresh` when no container by that name exists', () => {
		expect(decideRunAction(null, IMAGE)).toEqual({ kind: 'fresh' });
	});

	it('returns `adopt` for a running container with the matching image', () => {
		const inspected = { running: true, image: IMAGE, containerId: EXISTING_CONTAINER_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'adopt',
			containerId: EXISTING_CONTAINER_ID,
		});
	});

	it('returns `resume` for a stopped container with the matching image', () => {
		const inspected = { running: false, image: IMAGE, containerId: EXISTING_CONTAINER_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'resume',
			containerId: EXISTING_CONTAINER_ID,
		});
	});

	it('returns `recreate` for a running container with a DIFFERENT image', () => {
		const inspected = { running: true, image: OTHER_IMAGE, containerId: EXISTING_CONTAINER_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_CONTAINER_ID,
		});
	});

	it('returns `recreate` for a stopped container with a DIFFERENT image', () => {
		const inspected = { running: false, image: OTHER_IMAGE, containerId: EXISTING_CONTAINER_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_CONTAINER_ID,
		});
	});
});

// -----------------------------------------------------------------------------
// `Docker.run` resume-fallback — promotes `resume` to `recreate` and
// re-allocates ports rather than re-using the caller's stale `opts.ports`.
// -----------------------------------------------------------------------------

describe('Docker.run resume-fallback re-allocates ports', () => {
	it.effect(
		'when `docker start` fails, recreate WITHOUT the caller-supplied host port',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				// Stopped container with matching image → decision returns
				// `resume`. We force `docker start` to fail with exit code 1
				// to simulate the original host port being held by another
				// process; the dispatcher must promote to `recreate` and
				// run the fresh container WITHOUT `-p 9001:9000` (the
				// caller's stale host-port preference).
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						// After the fresh run, the dispatcher re-reads
						// PortBindings to learn what docker auto-allocated.
						portBindingsJson: '{"9000/tcp":[{"HostIp":"127.0.0.1","HostPort":"55512"}]}',
					},
				);

				const result = yield* Docker.run({
					name: 'sui.localnet',
					image,
					// Caller asked for host port 9001; we expect the resume
					// failure to make the dispatcher IGNORE this on the
					// recreate path.
					ports: { 9001: 9000 },
				}).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				// `docker start` was attempted and failed.
				expect(
					recorder.some(
						(r) => r.args[0] === 'start' && r.args[1] === EXISTING_CONTAINER_ID,
					),
				).toBe(true);

				// A fresh `docker run` followed.
				const runCmds = recorder.filter((r) => r.args[0] === 'run');
				expect(runCmds.length).toBe(1);
				const runArgs = runCmds[0]?.args ?? [];

				// The recreate path passes `-p <bind>::<container>` (host
				// port empty so docker auto-allocates), NOT
				// `-p <bind>:9001:9000` (the stale caller mapping).
				const hostBoundPortIdx = runArgs.findIndex((a) => a === '127.0.0.1:9001:9000');
				expect(hostBoundPortIdx).toBe(-1);
				const autoBoundPortIdx = runArgs.findIndex((a) => a === '127.0.0.1::9000');
				expect(autoBoundPortIdx).toBeGreaterThanOrEqual(0);

				// The result's hostPorts come from `inspectHostPorts` reading
				// the actual binding back from docker (55512 → 9000) — NOT
				// the caller's stale 9001.
				expect(result.hostPorts).toEqual({ 55512: 9000 });
				expect(result.reused).toBe(false);
			}),
	);
});

