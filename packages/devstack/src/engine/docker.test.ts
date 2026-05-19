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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Docker from './docker.js';
import { inspectContainerIp } from './docker/core.js';
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
	/**
	 * Sequence of stdout strings returned by successive `docker inspect`
	 * IP probes (`--format '{{(index .NetworkSettings.Networks
	 * "<net>").IPAddress}}'`). Used by tests that exercise the retry
	 * path in `inspectContainerIp` — the first N − 1 entries are empty
	 * and the last is a real IP. When unset, every probe returns a
	 * stable router-network IP `172.21.0.3` so the file-provider
	 * happy-path tests don't need to thread this through.
	 */
	readonly routerIpSequence?: ReadonlyArray<string>;
}

const makeSpawnerLayer = (
	recorder: Array<SpawnRecord>,
	inspectResponse: InspectResponse | null,
	options: SpawnerLayerOpts = {},
) => {
	// Index into `options.routerIpSequence` so successive IP probes get
	// successive responses. Closed-over state — one counter per spawner
	// layer, exactly mirroring how the real docker daemon's
	// `NetworkSettings.Networks` eventually populates after `network
	// connect` returns.
	let routerIpIdx = 0;
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			// Three inspect shapes are distinguished by the `--format`:
			//   1. name-inspect → `{{.State.Running}}|{{.Config.Image}}|{{.Id}}`
			//   2. host-port-inspect → `{{json .HostConfig.PortBindings}}`
			//   3. router-IP-inspect → `{{(index .NetworkSettings.Networks "devstack-router").IPAddress}}`
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt !== undefined && fmt.includes('PortBindings')) {
				return {
					stdout: `${options.portBindingsJson ?? 'null'}\n`,
					stderr: '',
					exitCode: 0,
				};
			}
			if (fmt !== undefined && fmt.includes('NetworkSettings.Networks')) {
				const seq = options.routerIpSequence;
				const next = seq === undefined ? '172.21.0.3' : (seq[routerIpIdx] ?? '');
				routerIpIdx++;
				return { stdout: `${next}\n`, stderr: '', exitCode: 0 };
			}
			if (inspectResponse === null) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			const { running, image, containerId } = inspectResponse;
			// Format mirrors `inspectContainer`'s `--format` string:
			//   `{{.State.Running}}|{{.Config.Image}}|{{.Id}}|{{.State.ExitCode}}`.
			// `0` is the default ExitCode for a running container that hasn't
			// exited yet — synthetic but it's what the parser sees.
			return {
				stdout: `${running}|${image}|${containerId}|0\n`,
				stderr: '',
				exitCode: 0,
			};
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
	it.effect('adopts an existing healthy container with the same image (skips docker run)', () =>
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

	it.effect('recreates when an existing container is running a DIFFERENT image', () =>
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
					recorder.some((r) => r.args[0] === 'start' && r.args[1] === EXISTING_CONTAINER_ID),
				).toBe(true);
			}),
	);

	it.effect('creates a new container when nothing matches the requested name', () =>
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
// Traefik file-provider materialization — `Docker.run({traefik: [...]})`:
//
//   1. DOES NOT stamp any `traefik.*` labels on the container (those
//      drove the docker provider, which raced with the two-step network
//      attach — see the `router.ts` architecture comment).
//   2. Connects the container to `devstack-router` after `docker run`.
//   3. Inspects the container's IP on `devstack-router` and writes one
//      `<dynDir>/<id>.yml` per RouterLabel, with `http://<ip>:<port>`
//      as the upstream URL.
//   4. Registers a finalizer that removes each YAML on scope close.
// -----------------------------------------------------------------------------

// Pin DEVSTACK_ROUTER_DYNAMIC_DIR to a per-test temp dir so the
// file-provider YAML writes land somewhere we can inspect and clean up
// without colliding with a real `~/.devstack/traefik/dynamic`.
//
// Uses `Effect.acquireUseRelease` (not a JS try/finally inside
// `Effect.gen`) so the env mutation + temp-dir cleanup straddle the
// ENTIRE Effect, including the scope-finalizer phase that runs after
// the `Effect.scoped` block returns. A naive try/finally would tear
// the env back down BEFORE finalizers fire, leaving them looking at
// the real home directory.
const withTempRouterDir = <A, E, R>(
	body: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
			const savedDirEnv = process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
			process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = dir;
			return { dir, savedDirEnv };
		}),
		({ dir }) => body(dir),
		({ dir, savedDirEnv }) =>
			Effect.sync(() => {
				if (savedDirEnv === undefined) {
					delete process.env.DEVSTACK_ROUTER_DYNAMIC_DIR;
				} else {
					process.env.DEVSTACK_ROUTER_DYNAMIC_DIR = savedDirEnv;
				}
				rmSync(dir, { recursive: true, force: true });
			}),
	);

describe('Docker.run traefik file-provider', () => {
	it.effect(
		'attaches to the router network and writes one file-provider YAML per RouterLabel with the resolved IP',
		() =>
			withTempRouterDir((dir) =>
				Effect.gen(function* () {
					const recorder: Array<SpawnRecord> = [];
					const image = 'mystenlabs/sui-tools:1.0.0';
					const spawnerLayer = makeSpawnerLayer(recorder, null, {
						// One IP probe per `Docker.run` call — the
						// materializer calls `inspectContainerIp` once
						// and shares the IP across that container's
						// RouterLabels.
						routerIpSequence: ['172.21.0.3'],
					});

					const rpcYamlPath = join(dir, 'testapp-main-sui-rpc.yml');
					const faucetYamlPath = join(dir, 'testapp-main-sui-faucet.yml');
					let rpcBodyDuringScope: string | undefined;
					let faucetBodyDuringScope: string | undefined;

					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* Docker.run({
								name: 'sui.localnet',
								image,
								traefik: [
									{
										id: 'testapp-main-sui-rpc',
										hostname: 'sui.testapp.localhost',
										entrypoint: 'sui-rpc',
										servicePort: 9000,
									},
									{
										id: 'testapp-main-sui-faucet',
										hostname: 'sui.testapp.localhost',
										entrypoint: 'sui-faucet',
										servicePort: 9123,
									},
								],
							});
							// Inside the scope: both YAMLs exist with the
							// resolved router-network IP folded into the
							// upstream URL.
							expect(existsSync(rpcYamlPath)).toBe(true);
							expect(existsSync(faucetYamlPath)).toBe(true);
							rpcBodyDuringScope = readFileSync(rpcYamlPath, 'utf8');
							faucetBodyDuringScope = readFileSync(faucetYamlPath, 'utf8');
						}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer)),
					);

					// 1. No `traefik.*` labels on the container — the
					//    file-provider does the work the docker provider
					//    used to do.
					const runCmd = recorder.find((r) => r.args[0] === 'run');
					expect(runCmd).toBeDefined();
					const runArgs = runCmd!.args;
					const labels = runArgs.flatMap((a, i) =>
						a === '--label' && runArgs[i + 1] !== undefined ? [runArgs[i + 1]!] : [],
					);
					expect(labels.some((l) => l.startsWith('traefik.'))).toBe(false);

					// 2. `docker network connect devstack-router <id>` issued.
					expect(
						recorder.some(
							(r) =>
								r.args[0] === 'network' &&
								r.args[1] === 'connect' &&
								r.args[2] === 'devstack-router',
						),
					).toBe(true);

					// 3. The YAMLs captured during the scope carry the
					//    resolved IP and correct entrypoint.
					expect(rpcBodyDuringScope).toContain('http://172.21.0.3:9000');
					expect(rpcBodyDuringScope).toContain('sui.testapp.localhost');
					expect(rpcBodyDuringScope).toContain('entrypoints: ["sui-rpc"]');
					expect(faucetBodyDuringScope).toContain('http://172.21.0.3:9123');
					expect(faucetBodyDuringScope).toContain('entrypoints: ["sui-faucet"]');

					// 4. Scope close fired the finalizers; both YAMLs are gone.
					expect(existsSync(rpcYamlPath)).toBe(false);
					expect(existsSync(faucetYamlPath)).toBe(false);
				}),
			),
	);

	it.effect(
		'omits the network connect and file-provider work when no traefik entries are supplied',
		() =>
			withTempRouterDir(() =>
				Effect.gen(function* () {
					const recorder: Array<SpawnRecord> = [];
					const image = 'mystenlabs/sui-tools:1.0.0';
					const spawnerLayer = makeSpawnerLayer(recorder, null);

					yield* Docker.run({ name: 'sui.localnet', image }).pipe(
						Effect.provide(spawnerLayer),
						Effect.provide(identityLayer),
						Effect.scoped,
					);

					expect(
						recorder.some(
							(r) =>
								r.args[0] === 'network' &&
								r.args[1] === 'connect' &&
								r.args[2] === 'devstack-router',
						),
					).toBe(false);
					// And no router-IP inspect was attempted.
					expect(
						recorder.some(
							(r) =>
								r.args[0] === 'inspect' &&
								r.args.some((a) => typeof a === 'string' && a.includes('NetworkSettings.Networks')),
						),
					).toBe(false);
				}),
			),
	);
});

// -----------------------------------------------------------------------------
// `inspectContainerIp` retry — the IP is empty on the first probe and
// resolves on a later one. The helper must keep probing until docker
// reports a non-empty address (within the retry budget) and not
// short-circuit on the first empty response.
// -----------------------------------------------------------------------------

describe('inspectContainerIp', () => {
	// `it.live` opts out of TestClock — the retry schedule sleeps
	// between attempts and TestClock would freeze them. Wall-clock
	// cost is bounded: 3 retries × 100ms = 300ms, well under the
	// default timeout.
	it.live('retries while docker reports an empty IP and returns the first non-empty value', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeSpawnerLayer(recorder, null, {
				routerIpSequence: ['', '', '172.21.0.7'],
			});
			const ip = yield* Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* inspectContainerIp(spawner, FAKE_CONTAINER_ID, 'devstack-router');
			}).pipe(Effect.provide(spawnerLayer));
			expect(ip).toBe('172.21.0.7');
			// Three IP-inspect calls were recorded.
			const ipProbes = recorder.filter(
				(r) =>
					r.args[0] === 'inspect' &&
					r.args.some((a) => typeof a === 'string' && a.includes('NetworkSettings.Networks')),
			);
			expect(ipProbes.length).toBe(3);
		}),
	);
});

// `decideRunAction` matrix coverage now lives in
// `engine/docker/ensure-container.test.ts` (audit finding E1 — the pure
// decision moved to the shared adopt/resume/recreate/fresh primitive
// alongside the new `RecreateReason` discriminator). Re-exported here
// from `./docker/core.js` for source-compat with downstream imports.

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
				}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer), Effect.scoped);

				// `docker start` was attempted and failed.
				expect(
					recorder.some((r) => r.args[0] === 'start' && r.args[1] === EXISTING_CONTAINER_ID),
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
				}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer), Effect.scoped);

				// `docker start` was attempted and failed.
				expect(
					recorder.some((r) => r.args[0] === 'start' && r.args[1] === EXISTING_CONTAINER_ID),
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

// -----------------------------------------------------------------------------
// `runOneShot({ onOutputLine })` — per-line streaming sink
// -----------------------------------------------------------------------------
//
// The supervisor needs to see deploy.sh output as it arrives, not after the
// one-shot's exit-code lands. We stream stdout and stderr through the
// caller-supplied callback (level: 'info' / 'warn') in addition to
// accumulating the full text on `result.stdout` / `result.stderr` — so a
// failed deploy still produces a `WalrusError({stderr})` with the captured
// text. These tests pin both halves of that contract using a synthetic
// spawner that emits a known multi-line stdout + stderr from `docker run`.

interface OutputSpawnerOpts {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode?: number;
}

const makeOutputSpawnerLayer = (recorder: Array<SpawnRecord>, output: OutputSpawnerOpts) => {
	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected piped command'));
		}
		recorder.push({ command: command.command, args: [...command.args] });
		const encoder = new TextEncoder();
		// Only the foreground `docker run` carries the workload output;
		// finalizer-time `docker rm -f` returns empty streams + exit 0.
		const isRunInvocation = command.args[0] === 'run';
		const stdoutBytes = encoder.encode(isRunInvocation ? output.stdout : '');
		const stderrBytes = encoder.encode(isRunInvocation ? output.stderr : '');
		const exit = isRunInvocation ? (output.exitCode ?? 0) : 0;
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(4242),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout: stdoutBytes.length > 0 ? Stream.succeed(stdoutBytes) : Stream.empty,
			stderr: stderrBytes.length > 0 ? Stream.succeed(stderrBytes) : Stream.empty,
			all: Stream.empty,
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};
	const impl = ChildProcessSpawner.make(spawn);
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, impl);
};

describe('Docker.runOneShot onOutputLine', () => {
	// Both stdout AND stderr default to 'info' — `normalizeLogLine` only
	// promotes to 'warn'/'error' when the line carries an embedded
	// structured-tracing level (text-prefix `WARN`/`ERROR` or JSON
	// `{level: "warn"}`). Plain text on either stream is info — matching
	// the long-running `attachLogFollower` path so one-shot logs see the
	// same treatment. See the `normalizeLogLine` comment in
	// `engine/docker/core.ts` for the rationale (Rust tracing containers
	// write info/debug to stderr too; the old `stderr = warn` blanket
	// misclassified ~95% of container log volume).
	it.effect(
		'forwards every stdout AND stderr line through the callback in their original order (default level: info)',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const captured: Array<{ level: string; line: string }> = [];
				const spawnerLayer = makeOutputSpawnerLayer(recorder, {
					stdout: 'step 1: starting\nstep 2: working\nstep 3: done\n',
					stderr: 'warning: deprecated flag\nerror: connection refused\n',
					exitCode: 0,
				});

				const result = yield* Docker.runOneShot({
					name: 'one-shot-stream',
					image: 'busybox:latest',
					args: ['true'],
					onOutputLine: (level, line) =>
						Effect.sync(() => {
							captured.push({ level, line });
						}),
				}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer));

				expect(result.exitCode).toBe(0);
				// Both streams arrive as 'info' — plain lines don't trigger
				// the level-promotion path in `normalizeLogLine`.
				expect(captured.every((e) => e.level === 'info')).toBe(true);
				const lines = captured.map((e) => e.line).sort();
				expect(lines).toEqual(
					[
						'error: connection refused',
						'step 1: starting',
						'step 2: working',
						'step 3: done',
						'warning: deprecated flag',
					].sort(),
				);
			}),
	);

	it.effect(
		'promotes stderr lines carrying an embedded tracing WARN/ERROR prefix to the matching level',
		() =>
			Effect.gen(function* () {
				const recorder: Array<SpawnRecord> = [];
				const captured: Array<{ level: string; line: string }> = [];
				const spawnerLayer = makeOutputSpawnerLayer(recorder, {
					stdout: '',
					// Two Rust-tracing-style stderr lines — the text-prefix
					// regex in `normalizeLogLine` extracts the level and
					// strips the timestamp+level prefix from the message.
					stderr:
						'2026-05-18T12:34:56.000Z WARN deprecated flag detected\n' +
						'2026-05-18T12:34:57.000Z ERROR connection refused\n',
					exitCode: 0,
				});

				yield* Docker.runOneShot({
					name: 'one-shot-tracing-stderr',
					image: 'busybox:latest',
					args: ['true'],
					onOutputLine: (level, line) =>
						Effect.sync(() => {
							captured.push({ level, line });
						}),
				}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer));

				expect(captured).toEqual([
					{ level: 'warn', line: 'deprecated flag detected' },
					{ level: 'error', line: 'connection refused' },
				]);
			}),
	);

	it.effect('preserves the accumulated stdout/stderr strings on the result', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeOutputSpawnerLayer(recorder, {
				stdout: 'line-a\nline-b\n',
				stderr: 'err-a\nerr-b\n',
				exitCode: 0,
			});

			const result = yield* Docker.runOneShot({
				name: 'one-shot-accumulate',
				image: 'busybox:latest',
				args: ['true'],
				// Sink that never fires — we just want to assert the
				// accumulated strings carry the full captured output
				// even when streaming is wired up.
				onOutputLine: () => Effect.void,
			}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer));

			expect(result.stdout).toBe('line-a\nline-b');
			expect(result.stderr).toBe('err-a\nerr-b');
		}),
	);

	it.effect('absent callback preserves the historical decode-to-string behavior', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeOutputSpawnerLayer(recorder, {
				stdout: 'plain stdout output\n',
				stderr: '',
				exitCode: 0,
			});

			const result = yield* Docker.runOneShot({
				name: 'one-shot-no-callback',
				image: 'busybox:latest',
				args: ['true'],
			}).pipe(Effect.provide(spawnerLayer), Effect.provide(identityLayer));

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('plain stdout output');
		}),
	);
});
