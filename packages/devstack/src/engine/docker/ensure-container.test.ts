// Unit tests for `ensureContainer` — the shared adopt / resume /
// recreate / fresh primitive (audit finding E1).
//
// Three test groups:
//
//   1. `decideRunAction` — pure state-machine matrix (same coverage as
//      the pre-E1 `docker.test.ts::decideRunAction` block, updated for
//      the new `RecreateReason` discriminator on `recreate` actions).
//
//   2. `ensureContainer` happy paths — adopt, resume, recreate (each of
//      the three reasons: image-mismatch, unclean-shutdown, resume-
//      failed), and fresh. Each scenario stubs the spawner to control
//      `docker inspect` / `docker start` / `docker run` responses, then
//      asserts the helper invokes the caller's `run` callback exactly
//      when expected.
//
//   3. `ensureContainer` race recovery — TOCTOU (start → missing → fall
//      back to fresh) and name-collision (run → exit 125 "already in
//      use" → fall back to start).
//
// Spawner stubbing mirrors `docker.test.ts`: each `ChildProcess.Command`
// is matched against its argv prefix and answered with a canned shape
// (stdout / stderr / exitCode). The `run` callback is a test-supplied
// closure that records its invocation count + the `RunContext` it
// received, so we can assert both that the helper called it AND that
// the context carried the right `recreateReason` / `resumeFailureStderr`.

import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import { DockerError } from '../errors.js';
import {
	_resetEnsureLocksForTest,
	decideRunAction,
	ensureContainer,
	type EnsureContainerSpec,
	type InspectResult,
	type RunContext,
} from './ensure-container.js';

const EXISTING_ID = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const FRESH_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const IMAGE = 'mystenlabs/sui-tools:1.0.0';
const OTHER_IMAGE = 'mystenlabs/sui-tools:2.0.0';
const NAME = 'devstack-testapp-build';

// -----------------------------------------------------------------------------
// `decideRunAction` — pure five-state matrix (with `RecreateReason`)
// -----------------------------------------------------------------------------

describe('decideRunAction', () => {
	it('returns `fresh` when no container by that name exists', () => {
		expect(decideRunAction(null, IMAGE)).toEqual({ kind: 'fresh' });
	});

	it('returns `adopt` for a running container with the matching image', () => {
		const inspected: InspectResult = { running: true, image: IMAGE, containerId: EXISTING_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({ kind: 'adopt', containerId: EXISTING_ID });
	});

	it('returns `resume` for a stopped container with the matching image', () => {
		const inspected: InspectResult = { running: false, image: IMAGE, containerId: EXISTING_ID };
		expect(decideRunAction(inspected, IMAGE)).toEqual({ kind: 'resume', containerId: EXISTING_ID });
	});

	it('returns `recreate(image-mismatch)` for a running container with a DIFFERENT image', () => {
		const inspected: InspectResult = {
			running: true,
			image: OTHER_IMAGE,
			containerId: EXISTING_ID,
		};
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_ID,
			reason: 'image-mismatch',
		});
	});

	it('returns `recreate(image-mismatch)` for a stopped container with a DIFFERENT image', () => {
		const inspected: InspectResult = {
			running: false,
			image: OTHER_IMAGE,
			containerId: EXISTING_ID,
		};
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_ID,
			reason: 'image-mismatch',
		});
	});

	// UNCLEAN_PRIOR_SHUTDOWN — exit 137 forces `recreate` over adopt /
	// resume. The on-disk state inconsistency a SIGKILL produces doesn't
	// heal just because the container came back up; we need a clean
	// container so the chain registry / package ids return to a known
	// state. Image mismatch still wins (different reason).
	it('returns `recreate(unclean-shutdown)` for a stopped container with exit 137', () => {
		const inspected: InspectResult = {
			running: false,
			image: IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 137,
		};
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_ID,
			reason: 'unclean-shutdown',
		});
	});

	it('returns `recreate(unclean-shutdown)` for a running container whose prior run exited 137', () => {
		const inspected: InspectResult = {
			running: true,
			image: IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 137,
		};
		expect(decideRunAction(inspected, IMAGE)).toEqual({
			kind: 'recreate',
			existingId: EXISTING_ID,
			reason: 'unclean-shutdown',
		});
	});

	it('returns `resume` for a stopped container that exited cleanly (exit 0)', () => {
		const inspected: InspectResult = {
			running: false,
			image: IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 0,
		};
		expect(decideRunAction(inspected, IMAGE)).toEqual({ kind: 'resume', containerId: EXISTING_ID });
	});

	it('honors `expectedExitCodes: [137]` and resumes a stopped container that exited 137', () => {
		// sui-localnet opt-out: `sui start --with-faucet` blocks before its
		// SIGINT handler registers, so PID 1 ALWAYS exits 137 on cycle
		// teardown by design. RocksDB's WAL replays cleanly on resume.
		const inspected: InspectResult = {
			running: false,
			image: IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 137,
		};
		expect(decideRunAction(inspected, IMAGE, [137])).toEqual({
			kind: 'resume',
			containerId: EXISTING_ID,
		});
	});

	it('honors `expectedExitCodes: [137]` and adopts a running container that previously exited 137', () => {
		const inspected: InspectResult = {
			running: true,
			image: IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 137,
		};
		expect(decideRunAction(inspected, IMAGE, [137])).toEqual({
			kind: 'adopt',
			containerId: EXISTING_ID,
		});
	});

	it('still recreates on image mismatch even when 137 is in `expectedExitCodes`', () => {
		// Defense-in-depth: the opt-out covers ONLY the unclean-shutdown
		// branch. An image mismatch still wins.
		const inspected: InspectResult = {
			running: false,
			image: OTHER_IMAGE,
			containerId: EXISTING_ID,
			lastExitCode: 137,
		};
		expect(decideRunAction(inspected, IMAGE, [137])).toEqual({
			kind: 'recreate',
			existingId: EXISTING_ID,
			reason: 'image-mismatch',
		});
	});
});

// -----------------------------------------------------------------------------
// `ensureContainer` — integration tests with stubbed spawner
// -----------------------------------------------------------------------------

interface SpawnRecord {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
}

interface InspectResponse {
	readonly running: boolean;
	readonly image: string;
	readonly containerId: string;
	readonly lastExitCode?: number;
}

interface SpawnerStubOptions {
	/** Response for the initial `docker inspect <name>` probe. `null`
	 *  means "no such container". Successive inspect calls (e.g. after
	 *  the collision-recovery `docker start`) use the same response. */
	readonly inspectResponse?: InspectResponse | null;
	/** Response from `docker start <id>` — exit code + stderr. Defaults
	 *  to exit 0 (success). */
	readonly startExitCode?: number;
	readonly startStderr?: string;
	/** Whether the inspect response should change AFTER the helper
	 *  invokes the recreate path's `removeContainerByNameBestEffort`.
	 *  Used by name-collision recovery: the first inspect sees nothing,
	 *  the second (after a failed `run` collision) sees the peer's
	 *  container so the start fallback can adopt it. */
	readonly inspectAfterRecover?: InspectResponse | null;
}

const makeSpawnerLayer = (recorder: Array<SpawnRecord>, options: SpawnerStubOptions = {}) => {
	let inspectCount = 0;
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt !== undefined && fmt.includes('PortBindings')) {
				return { stdout: 'null\n', stderr: '', exitCode: 0 };
			}
			// Pick the second response for inspects that come AFTER the
			// recovery-rm path. We approximate "after recovery" as
			// `inspectCount > 0` since recovery does one inspect first
			// then runs.
			const useAfter =
				inspectCount > 0 && options.inspectAfterRecover !== undefined;
			const resp = useAfter ? options.inspectAfterRecover : options.inspectResponse ?? null;
			inspectCount++;
			if (resp === null || resp === undefined) {
				return { stdout: '', stderr: 'No such object: ...\n', exitCode: 1 };
			}
			const exitCodeField = resp.lastExitCode ?? 0;
			return {
				stdout: `${resp.running}|${resp.image}|${resp.containerId}|${exitCodeField}\n`,
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
		if (args[0] === 'ps') return { stdout: '', stderr: '', exitCode: 0 };
		if (args[0] === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
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

// Test-friendly `run` callback that records every invocation. Returns
// `FRESH_ID` by default; pass `{failWith}` to force a failure for
// name-collision testing.
const makeRunRecorder = (opts: { readonly failWith?: DockerError } = {}) => {
	const calls: Array<RunContext> = [];
	const fn = (ctx: RunContext): Effect.Effect<string, DockerError, never> => {
		calls.push(ctx);
		if (opts.failWith !== undefined) return Effect.fail(opts.failWith);
		return Effect.succeed(FRESH_ID);
	};
	return { fn, calls };
};

describe('ensureContainer happy paths', () => {
	it.effect('adopts an existing running container with the matching image', () =>
		Effect.gen(function* () {
			_resetEnsureLocksForTest();
			const recorder: Array<SpawnRecord> = [];
			const { fn, calls } = makeRunRecorder();
			const layer = makeSpawnerLayer(recorder, {
				inspectResponse: { running: true, image: IMAGE, containerId: EXISTING_ID },
			});
			const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
			const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
			expect(result.containerId).toBe(EXISTING_ID);
			expect(result.reused).toBe(true);
			expect(result.resumed).toBe(false);
			// `run` callback never invoked on adopt.
			expect(calls.length).toBe(0);
			// No `docker run`, no `docker start`, no `docker rm`.
			expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
			expect(recorder.some((r) => r.args[0] === 'start')).toBe(false);
			expect(recorder.some((r) => r.args[0] === 'rm')).toBe(false);
		}),
	);

	it.effect('resumes a stopped container with the matching image via `docker start`', () =>
		Effect.gen(function* () {
			_resetEnsureLocksForTest();
			const recorder: Array<SpawnRecord> = [];
			const { fn, calls } = makeRunRecorder();
			const layer = makeSpawnerLayer(recorder, {
				inspectResponse: { running: false, image: IMAGE, containerId: EXISTING_ID },
			});
			const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
			const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
			expect(result.containerId).toBe(EXISTING_ID);
			expect(result.reused).toBe(true);
			expect(result.resumed).toBe(true);
			// `run` callback never invoked on resume.
			expect(calls.length).toBe(0);
			// `docker start <id>` was called.
			expect(recorder.some((r) => r.args[0] === 'start' && r.args[1] === EXISTING_ID)).toBe(true);
		}),
	);

	it.effect(
		'recreates with `recreateReason=image-mismatch` when the existing container runs a different image',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				const { fn, calls } = makeRunRecorder();
				const layer = makeSpawnerLayer(recorder, {
					inspectResponse: { running: true, image: OTHER_IMAGE, containerId: EXISTING_ID },
				});
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
				const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
				expect(result.containerId).toBe(FRESH_ID);
				expect(result.reused).toBe(false);
				expect(calls.length).toBe(1);
				expect(calls[0]).toEqual({
					reason: 'recreate',
					recreateReason: 'image-mismatch',
				});
				// `ps`-based remove sweep happened before `run`.
				const psIdx = recorder.findIndex((r) => r.args[0] === 'ps');
				expect(psIdx).toBeGreaterThanOrEqual(0);
			}),
	);

	it.effect(
		'recreates with `recreateReason=unclean-shutdown` when the prior run exited 137',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				const { fn, calls } = makeRunRecorder();
				const layer = makeSpawnerLayer(recorder, {
					inspectResponse: {
						running: false,
						image: IMAGE,
						containerId: EXISTING_ID,
						lastExitCode: 137,
					},
				});
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
				const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
				expect(result.containerId).toBe(FRESH_ID);
				expect(calls.length).toBe(1);
				expect(calls[0]?.recreateReason).toBe('unclean-shutdown');
			}),
	);

	it.effect('runs fresh when no container by that name exists', () =>
		Effect.gen(function* () {
			_resetEnsureLocksForTest();
			const recorder: Array<SpawnRecord> = [];
			const { fn, calls } = makeRunRecorder();
			const layer = makeSpawnerLayer(recorder, { inspectResponse: null });
			const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
			const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
			expect(result.containerId).toBe(FRESH_ID);
			expect(result.reused).toBe(false);
			expect(calls.length).toBe(1);
			expect(calls[0]).toEqual({ reason: 'fresh' });
		}),
	);
});

describe('ensureContainer race recovery', () => {
	// TOCTOU — Bug C — the container existed at inspect time but was
	// gone by the time `docker start` ran (peer's finalizer rm'd it
	// between our inspect and our start). The helper falls back to the
	// `run` callback as if it were a fresh create.
	it.effect(
		'falls back to fresh create when `docker start` reports "No such container"',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				const { fn, calls } = makeRunRecorder();
				const layer = makeSpawnerLayer(recorder, {
					inspectResponse: { running: false, image: IMAGE, containerId: EXISTING_ID },
					startExitCode: 1,
					startStderr: 'Error response from daemon: No such container: devstack-testapp-build\n',
				});
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
				const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
				expect(result.containerId).toBe(FRESH_ID);
				expect(result.reused).toBe(false);
				// The `run` callback DID fire — fresh path after TOCTOU.
				expect(calls.length).toBe(1);
				expect(calls[0]?.reason).toBe('fresh');
				// `docker start` was still attempted before the fallback.
				expect(recorder.some((r) => r.args[0] === 'start')).toBe(true);
			}),
	);

	// Resume-failure-NOT-TOCTOU promotion: `docker start` failed for
	// some OTHER reason (port conflict, OCI runtime error, etc.). The
	// helper promotes to `recreate` and passes `resumeFailureStderr`
	// through so the `run` callback can pattern-match.
	it.effect(
		'promotes resume → recreate with `resumeFailureStderr` when `docker start` fails for non-TOCTOU reasons',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				const { fn, calls } = makeRunRecorder();
				const layer = makeSpawnerLayer(recorder, {
					inspectResponse: { running: false, image: IMAGE, containerId: EXISTING_ID },
					startExitCode: 1,
					startStderr: 'Bind for 0.0.0.0:9001 failed: port is already allocated',
				});
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: fn };
				const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
				expect(result.containerId).toBe(FRESH_ID);
				expect(calls.length).toBe(1);
				expect(calls[0]?.reason).toBe('recreate');
				expect(calls[0]?.recreateReason).toBe('resume-failed');
				expect(calls[0]?.resumeFailureStderr).toContain('port is already allocated');
			}),
	);

	// Name-collision recovery — Bug H — `docker run` exit 125 with
	// "already in use" stderr means a peer beat us to the create.
	// The helper falls back to `docker start <name>` and adopts the
	// peer's container.
	it.effect(
		'falls back to `docker start` when the `run` callback fails with exit 125 + "already in use"',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				const { fn: failingRun, calls } = makeRunRecorder({
					failWith: new DockerError({
						phase: 'docker run',
						message: 'name collision',
						exitCode: 125,
						stderr: 'docker: Error response from daemon: Conflict. The container name "/devstack-testapp-build" is already in use by container "abcdef".',
					}),
				});
				const layer = makeSpawnerLayer(recorder, {
					// No container at inspect time → fresh path → `run`
					// fires → fails with collision → start fallback →
					// re-inspect by name returns the peer's container.
					inspectResponse: null,
					inspectAfterRecover: { running: true, image: IMAGE, containerId: EXISTING_ID },
					startExitCode: 0,
				});
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: failingRun };
				const result = yield* ensureContainer(spec).pipe(Effect.provide(layer));
				// Adopted the peer's container via `docker start`, so the
				// id is the peer's existing id (read via the post-start
				// inspect).
				expect(result.containerId).toBe(EXISTING_ID);
				// The `run` callback was invoked exactly once before the
				// collision recovery kicked in.
				expect(calls.length).toBe(1);
				// `docker start <name>` was called as the collision
				// recovery — verifying we didn't loop or recurse.
				const startCount = recorder.filter((r) => r.args[0] === 'start').length;
				expect(startCount).toBe(1);
				expect(recorder.some((r) => r.args[0] === 'start' && r.args[1] === NAME)).toBe(true);
			}),
	);

	it.effect(
		'propagates non-collision DockerError from the `run` callback without retrying',
		() =>
			Effect.gen(function* () {
				_resetEnsureLocksForTest();
				const recorder: Array<SpawnRecord> = [];
				// Non-collision failure (exit 1, generic error) — should NOT
				// trigger the start-fallback path.
				const { fn: failingRun, calls } = makeRunRecorder({
					failWith: new DockerError({
						phase: 'docker run',
						message: 'image pull failed',
						exitCode: 1,
						stderr: 'manifest unknown',
					}),
				});
				const layer = makeSpawnerLayer(recorder, { inspectResponse: null });
				const spec: EnsureContainerSpec = { name: NAME, image: IMAGE, run: failingRun };
				const exit = yield* ensureContainer(spec).pipe(
					Effect.provide(layer),
					Effect.flip,
				);
				expect(exit._tag).toBe('DockerError');
				expect((exit as DockerError).message).toBe('image pull failed');
				expect(calls.length).toBe(1);
				expect(recorder.some((r) => r.args[0] === 'start')).toBe(false);
			}),
	);
});
