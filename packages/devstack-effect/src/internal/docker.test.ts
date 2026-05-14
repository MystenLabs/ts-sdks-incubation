// Reuse-if-healthy behavior for `Docker.run`. The unit under test is the
// inspect-then-decide branch added so `r` (hot restart) doesn't tear down
// reusable docker containers. We stub the spawner so each `docker inspect`
// / `docker rm` / `docker run` returns a canned response, then assert the
// recorder shows the expected argv ordering (or absence) for each scenario.
//
// The bottom block covers the pure `decideRunAction` decision function
// directly — five matrix branches plus the runtime "resume failed →
// recreate" promotion. The promotion path has TWO variants gated on
// `docker start` stderr: port-conflict stderr → fresh run drops the
// caller's host ports and asks docker to auto-allocate; any other stderr
// (OCI runtime, image-pull glitch, transient daemon issue) → fresh run
// keeps the caller's original ports. See `Docker.run resume-fallback`.

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
	 * Stderr text emitted by `docker start`. The dispatcher inspects this
	 * to decide whether the resume failure was port-related (re-allocate
	 * ports on the fallback) or some other failure class (OCI runtime,
	 * image-pull glitch, …) where the caller's original ports are still
	 * correct. Defaults to empty.
	 */
	readonly startStderr?: string;
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
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			// Distinguish the name-inspect (returns running|image|id) from
			// the host-ports inspect (returns JSON for PortBindings) by
			// the `--format` argument shape.
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt !== undefined && fmt.includes('PortBindings')) {
				return {
					stdout: `${options.portBindingsJson ?? 'null'}\n`,
					stderr: '',
					exitCode: 0,
				};
			}
			if (inspectResponse === null) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			const { running, image, containerId } = inspectResponse;
			return { stdout: `${running}|${image}|${containerId}\n`, stderr: '', exitCode: 0 };
		}
		if (args[0] === 'start') {
			return {
				stdout: '',
				stderr: options.startStderr ?? '',
				exitCode: options.startExitCode ?? 0,
			};
		}
		if (args[0] === 'run') return { stdout: `${FAKE_CONTAINER_ID}\n`, stderr: '', exitCode: 0 };
		if (args[0] === 'ps') return { stdout: '', stderr: '', exitCode: 0 };
		return { stdout: '', stderr: '', exitCode: 0 };
	};

	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected piped command'));
		}
		recorder.push({ command: command.command, args: [...command.args] });
		const { stdout, stderr, exitCode } = respondTo(command.args);
		const encoder = new TextEncoder();
		const stdoutBytes = encoder.encode(stdout);
		const stderrBytes = encoder.encode(stderr);
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(1234),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout: Stream.succeed(stdoutBytes),
			stderr: stderr.length > 0 ? Stream.succeed(stderrBytes) : Stream.empty,
			all: Stream.succeed(stdoutBytes),
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
// `Docker.run` resume-fallback — promotes `resume` to `recreate` when
// `docker start` fails. Whether the fresh run reuses the caller's original
// host ports or asks docker to auto-allocate depends on WHY `docker start`
// failed:
//   - stderr matches a port-conflict pattern → drop opts.ports and
//     auto-allocate (something else holds the host port now)
//   - any other stderr (OCI runtime errors, image-pull glitches, transient
//     daemon issues) → keep the caller's original ports. Primitives that
//     publish endpoints like `http://localhost:2024` at init time depend on
//     this — re-allocating would silently move the endpoint and leave the
//     supervisor probing a port the container isn't bound to.
// -----------------------------------------------------------------------------

describe('Docker.run resume-fallback', () => {
	it.effect(
		'PORT CONFLICT: when `docker start` fails with "port is already allocated", recreate WITHOUT the caller-supplied host port',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				// Stopped container with matching image → decision returns
				// `resume`. We force `docker start` to fail with exit code 1
				// AND a stderr message matching the port-conflict predicate.
				// The dispatcher must promote to `recreate` and run the
				// fresh container WITHOUT `-p 9001:9000` (the caller's now-
				// unavailable host-port preference).
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						startStderr:
							'Error response from daemon: driver failed programming external connectivity on endpoint sui: Bind for 0.0.0.0:9001 failed: port is already allocated',
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

	it.effect(
		'CALLBACK: when `docker start` fails with a port conflict AND `onPortConflict` is supplied, the callback chooses the new ports',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				// Stopped container with matching image → decision returns
				// `resume`. `docker start` fails with port-conflict stderr.
				// `onPortConflict` is supplied — the callback returns the
				// allocator-driven "next preferred port" map. The recreate
				// path MUST use those ports as full `<bind>:<host>:<container>`
				// mappings (not auto-allocate) so the manifest publishes a
				// stable, readable URL.
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						startStderr:
							'Error response from daemon: driver failed programming external connectivity on endpoint sui: Bind for 0.0.0.0:9000 failed: port is already allocated',
					},
				);

				const callbackCalls: Array<Readonly<Record<number, number>>> = [];
				const onPortConflict = (
					conflicting: Readonly<Record<number, number>>,
				): Effect.Effect<Readonly<Record<number, number>>, Docker.DockerError, never> => {
					callbackCalls.push(conflicting);
					// Pretend the allocator scanned 9000 → 9001.
					return Effect.succeed({ 9001: 9000 });
				};

				const result = yield* Docker.run({
					name: 'sui.localnet',
					image,
					ports: { 9000: 9000 },
					onPortConflict,
				}).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				// Callback was invoked once with the conflicting (caller's
				// stale) host→container map.
				expect(callbackCalls.length).toBe(1);
				expect(callbackCalls[0]).toEqual({ 9000: 9000 });

				// A fresh `docker run` followed.
				const runCmds = recorder.filter((r) => r.args[0] === 'run');
				expect(runCmds.length).toBe(1);
				const runArgs = runCmds[0]?.args ?? [];

				// The recreate uses the callback's `9001 → 9000` mapping
				// as a FULL host:container binding — NOT auto-allocate
				// (`127.0.0.1::9000`) and NOT the caller's stale 9000.
				expect(runArgs.some((a) => a === '127.0.0.1:9001:9000')).toBe(true);
				expect(runArgs.some((a) => a === '127.0.0.1::9000')).toBe(false);
				expect(runArgs.some((a) => a === '127.0.0.1:9000:9000')).toBe(false);

				// `result.hostPorts` reflects the callback's mapping
				// directly — no `docker inspect` round-trip needed for
				// callback-driven recreates.
				expect(result.hostPorts).toEqual({ 9001: 9000 });
				expect(result.reused).toBe(false);
			}),
	);

	it.effect(
		'CALLBACK: callback re-allocates ALL conflicting ports (multi-port primitive case)',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						startStderr: 'Bind for 0.0.0.0:9000 failed: port is already allocated',
					},
				);

				// Caller passed sui-localnet's three ports (rpc, faucet,
				// graphql). The callback shifts each by +1 to simulate the
				// allocator's "next free preferred" behavior.
				const onPortConflict = (
					_conflicting: Readonly<Record<number, number>>,
				): Effect.Effect<Readonly<Record<number, number>>, Docker.DockerError, never> =>
					Effect.succeed({ 9001: 9000, 9124: 9123, 9126: 9125 });

				const result = yield* Docker.run({
					name: 'sui.localnet',
					image,
					ports: { 9000: 9000, 9123: 9123, 9125: 9125 },
					onPortConflict,
				}).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				const runCmds = recorder.filter((r) => r.args[0] === 'run');
				const runArgs = runCmds[0]?.args ?? [];

				// All three shifted bindings appear; none of the stale
				// caller-supplied ones do; no auto-allocate flags either.
				expect(runArgs.some((a) => a === '127.0.0.1:9001:9000')).toBe(true);
				expect(runArgs.some((a) => a === '127.0.0.1:9124:9123')).toBe(true);
				expect(runArgs.some((a) => a === '127.0.0.1:9126:9125')).toBe(true);
				expect(runArgs.some((a) => a === '127.0.0.1::9000')).toBe(false);
				expect(runArgs.some((a) => a === '127.0.0.1::9123')).toBe(false);
				expect(runArgs.some((a) => a === '127.0.0.1::9125')).toBe(false);

				expect(result.hostPorts).toEqual({ 9001: 9000, 9124: 9123, 9126: 9125 });
			}),
	);

	it.effect(
		'CALLBACK: a non-port `docker start` failure does NOT invoke `onPortConflict` (still keeps original ports)',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						startStderr:
							'Error response from daemon: failed to create task for container: OCI runtime create failed',
					},
				);

				let callbackInvoked = false;
				const onPortConflict = (
					_conflicting: Readonly<Record<number, number>>,
				): Effect.Effect<Readonly<Record<number, number>>, Docker.DockerError, never> => {
					callbackInvoked = true;
					return Effect.succeed({ 9999: 2024 });
				};

				const result = yield* Docker.run({
					name: 'seal.key-server',
					image,
					ports: { 2024: 2024 },
					onPortConflict,
				}).pipe(
					Effect.provide(spawnerLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);

				// `isPortConflictStderr` didn't match → callback NOT invoked.
				expect(callbackInvoked).toBe(false);

				const runCmds = recorder.filter((r) => r.args[0] === 'run');
				const runArgs = runCmds[0]?.args ?? [];
				// Caller's original `-p 2024:2024` mapping survives — the
				// failure class doesn't suggest the port is the problem.
				expect(runArgs.some((a) => a === '127.0.0.1:2024:2024')).toBe(true);
				expect(result.hostPorts).toEqual({ 2024: 2024 });
			}),
	);

	it.effect(
		'NON-PORT FAILURE: when `docker start` fails with an OCI runtime error, recreate WITH the ORIGINAL host port',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const image = 'mystenlabs/sui-tools:1.0.0';
				// Stopped container with matching image → decision returns
				// `resume`. `docker start` fails with stderr that does NOT
				// match the port-conflict predicate. This is the real-world
				// case that surfaced the regression: seal-key-server resume
				// hit `OCI runtime create failed: runc create failed`.
				// The dispatcher must still promote to `recreate` (to rm +
				// rerun) but the fresh run MUST keep the caller's original
				// `-p 2024:2024` mapping — the seal primitive published
				// `http://localhost:2024` at init time and never re-reads,
				// so the supervisor's ready-probe of port 2024 only works
				// if the recreated container is actually bound to 2024.
				const spawnerLayer = makeSpawnerLayer(
					recorder,
					{ running: false, image, containerId: EXISTING_CONTAINER_ID },
					{
						startExitCode: 1,
						startStderr:
							'Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process',
					},
				);

				const result = yield* Docker.run({
					name: 'seal.key-server',
					image,
					ports: { 2024: 2024 },
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

				// The recreate path keeps the ORIGINAL `-p 127.0.0.1:2024:2024`
				// mapping — NOT the auto-allocation variant
				// `-p 127.0.0.1::2024`.
				const hostBoundPortIdx = runArgs.findIndex((a) => a === '127.0.0.1:2024:2024');
				expect(hostBoundPortIdx).toBeGreaterThanOrEqual(0);
				const autoBoundPortIdx = runArgs.findIndex((a) => a === '127.0.0.1::2024');
				expect(autoBoundPortIdx).toBe(-1);

				// The result's hostPorts mirror the caller's `opts.ports`
				// because we did NOT re-allocate — primitives that
				// captured `http://localhost:2024` at init time are still
				// valid.
				expect(result.hostPorts).toEqual({ 2024: 2024 });
				expect(result.reused).toBe(false);
			}),
	);
});

