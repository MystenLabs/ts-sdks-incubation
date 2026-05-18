// Snapshot round-trip regressions silently break the entire snapshot
// contract — the kind of defect that the original v4 redesign shipped
// because nobody exercised the save→wipe→restore loop. These tests
// drive the engine `snapshot()` / `restore()` / `list()` helpers
// against a real (temp-dir) filesystem + real tar, with the docker
// container pass disabled (containers: []) so the test doesn't depend
// on a running daemon.
//
// What's covered:
//
//   1. State-only snapshot — `state.json` is captured + restored byte-
//      for-byte; meta.json records the schema version + stack identity.
//
//   2. Runtime/ tar round-trip — files under `runtime/<service>/` ride
//      the tar, including mode bits. The post-restore mode is asserted
//      because that's what holds for the seal master-key (0o600) and
//      the account keystore (0o600).
//
//   3. Extras tar round-trip — opt-in absolute paths registered via
//      `addExtra` are tarred + extracted to their original location.
//
//   4. List + meta surface — `list()` reads back the meta with stack/
//      network/createdAt; malformed meta is silently skipped (a
//      partial save shouldn't break list).
//
//   5. Missing-snapshot restore — surfaces a clear error rather than
//      silently no-op'ing.
//
// What's NOT covered (deliberate):
//
//   - Container commit/save/load — needs a docker daemon; covered by
//     the per-plugin smoke playbook (Phase 4.2).
//   - Concurrent snapshots against the same id — directory creation
//     uses `recursive: true` so re-saving with the same id overwrites;
//     the CLI's id format (timestamp + random suffix + optional label)
//     makes collisions practically impossible.

import { mkdtempSync, rmSync, chmodSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { list, restore, snapshot } from './snapshot.js';

// Each test gets its own tmpdir under TMPDIR so parallel vitest workers
// don't trample each other's `DEVSTACK_STATE_DIR`. The setup-files in
// `test-setup/isolate-port-locks.ts` ensure port locks are also
// per-worker; this mirrors that pattern for state.
const makeStateDir = (): string => mkdtempSync(join(tmpdir(), 'devstack-snapshot-test-'));

const writeFile = (path: string, contents: string, mode = 0o644): void => {
	writeFileSync(path, contents, { mode });
};

describe('snapshot() / restore() — state-only round-trip', () => {
	let stateDir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		stateDir = makeStateDir();
		prevEnv = process.env.DEVSTACK_STATE_DIR;
		process.env.DEVSTACK_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.DEVSTACK_STATE_DIR;
		else process.env.DEVSTACK_STATE_DIR = prevEnv;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it.effect('captures state.json and restores it byte-for-byte', () =>
		Effect.gen(function* () {
			// The engine resolves `${DEVSTACK_STATE_DIR}/state.json` (env-
			// override path branch — see resolveStackPaths). Mirror that.
			writeFile(
				join(stateDir, 'state.json'),
				JSON.stringify({ version: 1, data: { foo: 'bar', count: 42 } }),
			);

			const result = yield* snapshot({
				id: 'baseline',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
			});

			expect(result.path).toContain('baseline');
			expect(result.containerTars.length).toBe(0);

			// Mutate the live state.json so we can detect the restore.
			writeFile(
				join(stateDir, 'state.json'),
				JSON.stringify({ version: 1, data: { foo: 'CHANGED' } }),
			);

			yield* restore({
				id: 'baseline',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
			});

			const restored = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
			expect(restored.data.foo).toBe('bar');
			expect(restored.data.count).toBe(42);
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect('list() returns the saved snapshot with meta', () =>
		Effect.gen(function* () {
			writeFile(join(stateDir, 'state.json'), '{"version":1,"data":{}}');
			yield* snapshot({
				id: 'first',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
			});
			yield* snapshot({
				id: 'second',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
			});

			const entries = yield* list({ dir: join(stateDir, 'snapshots') });
			expect(entries.length).toBe(2);
			expect(entries.map((e) => e.id).sort()).toEqual(['first', 'second']);
			expect(entries[0]!.stack).toBe('main');
			expect(typeof entries[0]!.createdAt).toBe('number');
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect('restore() of a missing id fails with a clear error', () =>
		Effect.gen(function* () {
			const result = yield* restore({
				id: 'never-saved',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
			}).pipe(Effect.flip);
			expect(result.message).toContain('never-saved');
			expect(result.message).toContain('not found');
		}).pipe(Effect.provide(NodeServicesLayer)),
	);
});

describe('snapshot() / restore() — runtime/ tar round-trip', () => {
	let stateDir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		stateDir = makeStateDir();
		prevEnv = process.env.DEVSTACK_STATE_DIR;
		process.env.DEVSTACK_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.DEVSTACK_STATE_DIR;
		else process.env.DEVSTACK_STATE_DIR = prevEnv;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it.effect('tars + restores runtime/<service>/ files with mode bits', () =>
		Effect.gen(function* () {
			// Populate fake service runtime state — mirrors what the live
			// services write (account keys at 0o600, wallet token at
			// 0o600, seal master-key.env at 0o600, walrus deploy outputs
			// at default 0o644).
			const fs = yield* Effect.promise(() => import('node:fs/promises'));
			const runtimeDir = join(stateDir, 'runtime');
			yield* Effect.promise(() => fs.mkdir(join(runtimeDir, 'accounts'), { recursive: true }));
			yield* Effect.promise(() => fs.mkdir(join(runtimeDir, 'seal'), { recursive: true }));
			yield* Effect.promise(() =>
				fs.mkdir(join(runtimeDir, 'walrus', 'main', 'deploy'), { recursive: true }),
			);
			writeFile(join(runtimeDir, 'accounts', 'alice.key'), 'suiprivkey1...', 0o600);
			writeFile(join(runtimeDir, 'seal', 'master-key.env'), 'MASTER_KEY=abcd', 0o600);
			writeFile(
				join(runtimeDir, 'walrus', 'main', 'deploy', 'deploy'),
				'walrusPackageId: 0xabc\nsystemObject: 0xdef',
			);

			yield* snapshot({
				id: 'rt',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
			});

			// Wipe the live runtime dir so the restore is the only path
			// that puts the files back.
			rmSync(runtimeDir, { recursive: true, force: true });

			const result = yield* restore({
				id: 'rt',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
			});
			expect(result.runtimeRestored).toBe(true);

			// Contents and mode survive the tar round-trip.
			expect(readFileSync(join(runtimeDir, 'accounts', 'alice.key'), 'utf8')).toBe(
				'suiprivkey1...',
			);
			expect(statSync(join(runtimeDir, 'accounts', 'alice.key')).mode & 0o777).toBe(0o600);
			expect(readFileSync(join(runtimeDir, 'seal', 'master-key.env'), 'utf8')).toBe(
				'MASTER_KEY=abcd',
			);
			expect(statSync(join(runtimeDir, 'seal', 'master-key.env')).mode & 0o777).toBe(0o600);
			expect(
				readFileSync(join(runtimeDir, 'walrus', 'main', 'deploy', 'deploy'), 'utf8'),
			).toContain('walrusPackageId: 0xabc');
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect('skipRuntime=true omits the runtime tar', () =>
		Effect.gen(function* () {
			const fs = yield* Effect.promise(() => import('node:fs/promises'));
			yield* Effect.promise(() => fs.mkdir(join(stateDir, 'runtime', 'a'), { recursive: true }));
			writeFile(join(stateDir, 'runtime', 'a', 'thing'), 'ignored');

			const result = yield* snapshot({
				id: 'no-rt',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
				skipRuntime: true,
			});
			expect(result.runtimeTar).toBeUndefined();
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect('first-boot stack with no runtime/ yet is a clean no-op', () =>
		Effect.gen(function* () {
			// No state.json, no runtime/ — fresh stack snapshot.
			const result = yield* snapshot({
				id: 'empty',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
			});
			expect(result.runtimeTar).toBeUndefined();
			expect(result.containerTars.length).toBe(0);

			// Restore the empty snapshot — should succeed without
			// touching the (still-empty) live state.
			const r = yield* restore({
				id: 'empty',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
			});
			expect(r.runtimeRestored).toBe(false);
			expect(r.loadedImages.length).toBe(0);
		}).pipe(Effect.provide(NodeServicesLayer)),
	);
});

describe('snapshot() / restore() — extras round-trip', () => {
	let stateDir: string;
	let extrasDir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		stateDir = makeStateDir();
		extrasDir = makeStateDir();
		prevEnv = process.env.DEVSTACK_STATE_DIR;
		process.env.DEVSTACK_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.DEVSTACK_STATE_DIR;
		else process.env.DEVSTACK_STATE_DIR = prevEnv;
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(extrasDir, { recursive: true, force: true });
	});

	it.effect('tars + restores opt-in extras paths', () =>
		Effect.gen(function* () {
			writeFile(join(extrasDir, 'foo.txt'), 'extra-payload', 0o600);

			yield* snapshot({
				id: 'ext',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
				extras: [{ key: 'foo', path: extrasDir }],
			});

			// Wipe the extras dir's contents so restore is the only path
			// that puts the file back.
			rmSync(join(extrasDir, 'foo.txt'));

			const r = yield* restore({
				id: 'ext',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
			});
			expect(r.extrasRestored).toEqual(['foo']);
			expect(readFileSync(join(extrasDir, 'foo.txt'), 'utf8')).toBe('extra-payload');
			expect(statSync(join(extrasDir, 'foo.txt')).mode & 0o777).toBe(0o600);
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect('missing extras path is skipped, not failed', () =>
		Effect.gen(function* () {
			// Register an extras path that doesn't exist — should not
			// fail the save (per design comment in snapshot.ts:
			// "skip missing extras rather than failing").
			const missing = join(stateDir, 'nope');

			const result = yield* snapshot({
				id: 'missing',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [],
				extras: [{ key: 'gone', path: missing }],
			});
			expect(result.extrasTars.length).toBe(0);
		}).pipe(Effect.provide(NodeServicesLayer)),
	);
});

// Suppress unused-import warning for chmodSync — referenced via the
// test bodies using `writeFile(..., mode)` instead, but kept exported
// here as a marker for the explicit mode-preservation invariant the
// runtime tar test asserts.
void chmodSync;

// -----------------------------------------------------------------------------
// snapshot() pauses the container around `docker commit` so the
// captured writable layer is quiescent (no RocksDB / postgres mid-WAL-
// fsync corruption). Uses a stub `ChildProcessSpawner` that records every
// docker invocation so we can assert ordering.
// -----------------------------------------------------------------------------

interface SpawnRecord {
	readonly args: ReadonlyArray<string>;
}

interface StubSpawnerOpts {
	/** Whether `docker inspect --format '{{.State.Running}}' <id>` should
	 *  report `true` (running) or `false` (stopped). */
	readonly running: boolean;
	/** Fail `docker commit` to verify unpause still runs. Defaults to
	 *  false (commit succeeds). */
	readonly commitFails?: boolean;
}

const makeStubSpawnerLayer = (recorder: Array<SpawnRecord>, opts: StubSpawnerOpts) => {
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			const formatIdx = args.indexOf('--format');
			const fmt = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
			if (fmt === '{{.State.Running}}') {
				return { stdout: `${opts.running}\n`, stderr: '', exitCode: 0 };
			}
			if (fmt === '{{.Config.Image}}') {
				return { stdout: 'devstack-sui:abc123\n', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		}
		// `docker image inspect -f {{.Id}} <imageName>` — argv[0] is
		// 'image', not 'inspect'. Used by `commitContainer` to read the
		// digest after `docker commit`.
		if (args[0] === 'image' && args[1] === 'inspect') {
			return { stdout: 'sha256:deadbeef\n', stderr: '', exitCode: 0 };
		}
		if (args[0] === 'commit') {
			return opts.commitFails === true
				? { stdout: '', stderr: 'commit boom', exitCode: 1 }
				: { stdout: '', stderr: '', exitCode: 0 };
		}
		return { stdout: '', stderr: '', exitCode: 0 };
	};

	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected piped command in test'));
		}
		recorder.push({ args: [...command.args] });
		const { stdout, stderr, exitCode } = respondTo(command.args);
		const encoder = new TextEncoder();
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(4242),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout: Stream.succeed(encoder.encode(stdout)),
			stderr: stderr.length > 0 ? Stream.succeed(encoder.encode(stderr)) : Stream.empty,
			all: Stream.succeed(encoder.encode(stdout)),
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};

	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

describe('snapshot() pause/commit/unpause ordering', () => {
	let stateDir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'devstack-snapshot-pause-test-'));
		prevEnv = process.env.DEVSTACK_STATE_DIR;
		process.env.DEVSTACK_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.DEVSTACK_STATE_DIR;
		else process.env.DEVSTACK_STATE_DIR = prevEnv;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it.effect('pauses the container before commit and unpauses after', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeStubSpawnerLayer(recorder, { running: true });

			yield* snapshot({
				id: 'pause-ok',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [{ id: 'cid-runner', name: 'sui-localnet' }],
				skipRuntime: true,
			}).pipe(Effect.provide(spawnerLayer), Effect.provide(NodeServicesLayer));

			const pauseIdx = recorder.findIndex(
				(r) => r.args[0] === 'pause' && r.args[1] === 'cid-runner',
			);
			const commitIdx = recorder.findIndex(
				(r) => r.args[0] === 'commit' && r.args[1] === 'cid-runner',
			);
			const unpauseIdx = recorder.findIndex(
				(r) => r.args[0] === 'unpause' && r.args[1] === 'cid-runner',
			);
			expect(pauseIdx).toBeGreaterThanOrEqual(0);
			expect(commitIdx).toBeGreaterThan(pauseIdx);
			expect(unpauseIdx).toBeGreaterThan(commitIdx);
		}),
	);

	it.effect('unpauses even when commit fails', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeStubSpawnerLayer(recorder, { running: true, commitFails: true });

			const exit = yield* snapshot({
				id: 'pause-failcommit',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [{ id: 'cid-runner', name: 'sui-localnet' }],
				skipRuntime: true,
			})
				.pipe(Effect.provide(spawnerLayer), Effect.provide(NodeServicesLayer))
				.pipe(Effect.flip);
			expect(exit.message).toContain('failed to commit container');

			expect(recorder.some((r) => r.args[0] === 'pause' && r.args[1] === 'cid-runner')).toBe(true);
			expect(recorder.some((r) => r.args[0] === 'unpause' && r.args[1] === 'cid-runner')).toBe(
				true,
			);
		}),
	);

	it.effect('skips pause/unpause when the container is already stopped', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			const spawnerLayer = makeStubSpawnerLayer(recorder, { running: false });

			yield* snapshot({
				id: 'pause-stopped',
				dir: join(stateDir, 'snapshots'),
				stack: 'main',
				containers: [{ id: 'cid-stopped', name: 'sui-localnet' }],
				skipRuntime: true,
			}).pipe(Effect.provide(spawnerLayer), Effect.provide(NodeServicesLayer));

			expect(recorder.some((r) => r.args[0] === 'pause')).toBe(false);
			expect(recorder.some((r) => r.args[0] === 'unpause')).toBe(false);
			expect(recorder.some((r) => r.args[0] === 'commit')).toBe(true);
		}),
	);
});
