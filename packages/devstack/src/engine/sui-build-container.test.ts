// Coverage for the long-lived per-stack build container (Stage 2 of
// the publishMove perf work).
//
// Two layers of tests:
//
//   1. Pure helpers (`containerNameFor`, `toContainerPath`) — fast,
//      deterministic, no docker.
//   2. Layer-build tests that exercise `SuiBuildContainerLive`'s
//      adopt-or-create branch matrix against a fake `ChildProcessSpawner`.
//      Mirrors the recorder pattern in `docker.test.ts` so each docker
//      argv that the layer emits is asserted by the recorder. No real
//      docker daemon involved.

import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { Identity } from './identity.js';
import { SuiBuildImage } from './sui-cli.js';
import {
	SuiBuildContainer,
	SuiBuildContainerLive,
	containerNameFor,
	sweepStaleGitLocks,
	toContainerPath,
} from './sui-build-container.js';

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

describe('containerNameFor', () => {
	it('produces `devstack-<app>-build` per the user-facing contract', () => {
		// Per-`app` naming (stack-agnostic) so flipping
		// `DEVSTACK_STACK` against an already-warm container reuses
		// the same `~/.move` cache + container instead of paying a
		// cold image-pull + container-start cost.
		expect(containerNameFor({ app: 'wallet', stack: 'main' })).toBe('devstack-wallet-build');
		expect(containerNameFor({ app: 'wallet', stack: 'test' })).toBe('devstack-wallet-build');
	});

	it('does not include the network or stack dimension', () => {
		// `sui move build` is network-agnostic (only compiles
		// bytecode) AND stack-agnostic (bind-mount path is per-app,
		// not per-stack). Two stacks against the same app share the
		// same container and serialize their builds through it.
		const a = containerNameFor({ app: 'wallet', stack: 'main' });
		const b = containerNameFor({ app: 'wallet', stack: 'test' });
		expect(a).toBe(b);
	});
});

describe('toContainerPath', () => {
	it('translates an in-appDir path to `/host/<rel>`', () => {
		const out = toContainerPath('/Users/me/app', '/Users/me/app/move/usdc');
		expect(out).toBe('/host/move/usdc');
	});

	it('handles deep nesting under the app dir', () => {
		// Vendored deepbook source lives at `.devstack/imports/.../packages/deepbook` —
		// 5+ segments deep. The translation must preserve the full path,
		// not just the immediate child.
		const out = toContainerPath(
			'/Users/me/app',
			'/Users/me/app/.devstack/imports/mystenlabs_deepbookv3@v7.0.0/packages/deepbook',
		);
		expect(out).toBe('/host/.devstack/imports/mystenlabs_deepbookv3@v7.0.0/packages/deepbook');
	});

	it('returns undefined when hostPath escapes the app dir (parent reference)', () => {
		// A user publishing a Move package via a relative path that
		// resolves above their app dir can't be served by this
		// container's `/host` mount — the caller must fall back to
		// per-build `docker run --rm` with a fresh mount.
		expect(toContainerPath('/Users/me/app', '/Users/me/other-thing/move')).toBeUndefined();
	});

	it('returns undefined when hostPath is an unrelated absolute path', () => {
		// Symlinks, system paths, etc. — anything not under the app dir
		// fails canExec.
		expect(toContainerPath('/Users/me/app', '/tmp/something')).toBeUndefined();
	});

	it('returns `/host` when hostPath equals appDir itself', () => {
		// path.relative(appDir, appDir) is the empty string. A
		// publishMove against the app dir root is unusual but should
		// degrade to a well-defined mount point rather than producing
		// a malformed `/host/`-with-trailing-slash.
		const out = toContainerPath('/Users/me/app', '/Users/me/app');
		expect(out).toBe('/host');
	});
});

// -----------------------------------------------------------------------------
// sweepStaleGitLocks — stale-`.git/*.lock` reclamation
// -----------------------------------------------------------------------------
//
// `withMoveBuildLock` runs `sweepStaleGitLocks` after acquiring the
// cross-process lock so leftovers from a SIGKILL'd previous build don't
// block the next `sui move build` with `fatal: Unable to create
// '<repo>/.git/index.lock': File exists`. The sweep must:
//
//   1. Remove `.git/index.lock` / `sparse-checkout.lock` / etc. when
//      their mtime is older than the safety window.
//   2. LEAVE young lock files alone (a real in-flight git op).
//   3. Ignore dot-prefixed entries at the `git/` root (sui-cli's own
//      per-repo locks, NOT git's).
//   4. Tolerate missing dirs / unreadable entries silently.

describe('sweepStaleGitLocks', () => {
	const tmpRoot = (): string =>
		fs.mkdtempSync(join(os.tmpdir(), 'devstack-sweep-stale-git-locks-'));

	it('removes stale `.git/index.lock` and `info/sparse-checkout.lock` whose mtime exceeds the safety window', () =>
		Effect.gen(function* () {
			const moveHome = tmpRoot();
			const gitDir = join(moveHome, 'git', 'https___example_git', '.git');
			fs.mkdirSync(join(gitDir, 'info'), { recursive: true });
			const stale = [
				join(gitDir, 'index.lock'),
				join(gitDir, 'HEAD.lock'),
				join(gitDir, 'config.lock'),
				join(gitDir, 'shallow.lock'),
				join(gitDir, 'packed-refs.lock'),
				join(gitDir, 'info', 'sparse-checkout.lock'),
			];
			const ancient = new Date(Date.now() - 5 * 60 * 1000); // 5min ago
			for (const p of stale) {
				fs.writeFileSync(p, '');
				fs.utimesSync(p, ancient, ancient);
			}
			const removed = yield* sweepStaleGitLocks(moveHome);
			expect([...removed].sort()).toEqual([...stale].sort());
			for (const p of stale) {
				expect(fs.existsSync(p)).toBe(false);
			}
			fs.rmSync(moveHome, { recursive: true, force: true });
		}).pipe(Effect.runPromise));

	it('leaves fresh lock files alone (real in-flight git op)', () =>
		Effect.gen(function* () {
			const moveHome = tmpRoot();
			const gitDir = join(moveHome, 'git', 'https___example_git', '.git');
			fs.mkdirSync(gitDir, { recursive: true });
			const fresh = join(gitDir, 'index.lock');
			fs.writeFileSync(fresh, '');
			// utimes default = "now"; no override.
			const removed = yield* sweepStaleGitLocks(moveHome);
			expect(removed).toEqual([]);
			expect(fs.existsSync(fresh)).toBe(true);
			fs.rmSync(moveHome, { recursive: true, force: true });
		}).pipe(Effect.runPromise));

	it('removes stale sui-cli per-repo lock sentinels (`.<repo>.lock` at the `git/` root)', () =>
		Effect.gen(function* () {
			// `~/.move/git/.<repo>.lock` is sui-cli's own per-repo locking
			// layer. A crashed sui-cli leaves these as 0-byte sentinels
			// and the next build refuses to touch the repo. Same 60s
			// safety window — fresh ones from a live sui-cli are spared.
			const moveHome = tmpRoot();
			const root = join(moveHome, 'git');
			fs.mkdirSync(root, { recursive: true });
			const staleSentinel = join(root, '.cdb4ee2.lock');
			const freshSentinel = join(root, '.https___sui.lock');
			fs.writeFileSync(staleSentinel, '');
			fs.writeFileSync(freshSentinel, '');
			const ancient = new Date(Date.now() - 5 * 60 * 1000);
			fs.utimesSync(staleSentinel, ancient, ancient);
			// freshSentinel keeps "now" mtime — should be spared.
			const removed = yield* sweepStaleGitLocks(moveHome);
			expect(removed).toEqual([staleSentinel]);
			expect(fs.existsSync(staleSentinel)).toBe(false);
			expect(fs.existsSync(freshSentinel)).toBe(true);
			fs.rmSync(moveHome, { recursive: true, force: true });
		}).pipe(Effect.runPromise));

	it('leaves non-`.lock` dotfiles at the `git/` root untouched', () =>
		Effect.gen(function* () {
			// A stray `.DS_Store` or similar is not a lock file and the
			// sweep must not remove it even if its mtime is old.
			const moveHome = tmpRoot();
			const root = join(moveHome, 'git');
			fs.mkdirSync(root, { recursive: true });
			const dsStore = join(root, '.DS_Store');
			fs.writeFileSync(dsStore, '');
			const ancient = new Date(Date.now() - 5 * 60 * 1000);
			fs.utimesSync(dsStore, ancient, ancient);
			const removed = yield* sweepStaleGitLocks(moveHome);
			expect(removed).toEqual([]);
			expect(fs.existsSync(dsStore)).toBe(true);
			fs.rmSync(moveHome, { recursive: true, force: true });
		}).pipe(Effect.runPromise));

	it('returns empty when `<moveHome>/git/` does not exist', () =>
		Effect.gen(function* () {
			const moveHome = tmpRoot();
			// `<moveHome>/git/` deliberately not created.
			const removed = yield* sweepStaleGitLocks(moveHome);
			expect(removed).toEqual([]);
			fs.rmSync(moveHome, { recursive: true, force: true });
		}).pipe(Effect.runPromise));
});

// -----------------------------------------------------------------------------
// SuiBuildContainerLive — adopt-or-create matrix
// -----------------------------------------------------------------------------
//
// The layer must `docker inspect` first and then choose one of four
// branches:
//
//   1. no container exists           → `docker run -d --name ... sleep infinity`
//   2. exists, wrong image           → `docker rm -f ...` then run -d
//   3. exists, right image, stopped  → `docker start ...`
//   4. exists, right image, running  → adopt as-is (no run/start/rm)
//
// The layer-build scope is closed at the end of each `it.effect` so
// the cleanup finalizer fires; that finalizer issues `docker rm -f ...`.

interface SpawnRecord {
	readonly args: ReadonlyArray<string>;
}

interface InspectResponse {
	readonly running: boolean;
	readonly image: string;
}

const FAKE_RUN_STDOUT = 'abcdef0123\n';
// `--format` format is now `Running|Image|Id|ExitCode` — the four-field
// shape the shared `engine/docker/ensure-container.ts::ensureContainer`
// helper parses (audit finding E1). Synthesize a placeholder id +
// exit-code-0 for the running / stopped-clean variants the tests
// exercise.
const FAKE_EXISTING_ID = 'abc123def456abc123def456abc123def456';

const makeFakeSpawner = (recorder: Array<SpawnRecord>, inspect: InspectResponse | null) => {
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			if (inspect === null) return { stdout: '', stderr: 'No such object\n', exitCode: 1 };
			return {
				stdout: `${inspect.running}|${inspect.image}|${FAKE_EXISTING_ID}|0\n`,
				stderr: '',
				exitCode: 0,
			};
		}
		// The shared `ensureContainer` helper does a `docker ps -a -q
		// --filter name=^/<name>$` lookup on the recreate path to find
		// containers to rm — return the existing id when an inspect
		// response is set (i.e. a container DOES exist with that name)
		// so the recreate path actually fires the rm. Return empty on
		// the null case so the fresh path doesn't try to rm.
		if (args[0] === 'ps') {
			return {
				stdout: inspect === null ? '' : `${FAKE_EXISTING_ID}\n`,
				stderr: '',
				exitCode: 0,
			};
		}
		if (args[0] === 'run') return { stdout: FAKE_RUN_STDOUT, stderr: '', exitCode: 0 };
		if (args[0] === 'start') return { stdout: '', stderr: '', exitCode: 0 };
		if (args[0] === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
		if (args[0] === 'exec') return { stdout: '', stderr: '', exitCode: 0 };
		return { stdout: '', stderr: '', exitCode: 0 };
	};

	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected non-standard command in build-container test'));
		}
		recorder.push({ args: [...command.args] });
		const { stdout, stderr, exitCode } = respondTo(command.args);
		const encoder = new TextEncoder();
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(7777),
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

	const impl = ChildProcessSpawner.make(spawn);
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, impl);
};

const identityLayer = Layer.succeed(Identity, {
	app: 'walletapp',
	stack: 'main',
	network: 'localnet',
});

const imageLayer = Layer.succeed(SuiBuildImage, { tag: 'devstack/sui:1.71.0' });

const otherImageLayer = Layer.succeed(SuiBuildImage, { tag: 'devstack/sui:2.0.0' });

// Container name is now `devstack-<app>-build` (post-Phase 9 perf
// fix); the previous `<app>-<stack>-build` shape forced a fresh
// image-pull every time DEVSTACK_STACK changed.
const EXPECTED_NAME = 'devstack-walletapp-build';

describe('SuiBuildContainerLive — adopt-or-create', () => {
	it.effect('creates a fresh detached container when none exists with that name', () => {
		const recorder: Array<SpawnRecord> = [];
		return Effect.gen(function* () {
			const svc = yield* SuiBuildContainer;
			expect(svc.canExec(join(process.cwd(), 'some/pkg'))).toBe(true);
		}).pipe(
			Effect.provide(SuiBuildContainerLive),
			Effect.provide(makeFakeSpawner(recorder, null)),
			Effect.provide(imageLayer),
			Effect.provide(identityLayer),
			Effect.scoped,
			Effect.tap(() =>
				Effect.sync(() => {
					const runRec = recorder.find((r) => r.args[0] === 'run');
					expect(runRec).toBeDefined();
					// Asserts the bind-mount surface and the sleep-infinity
					// entrypoint that keeps the container idle between exec calls.
					expect(runRec!.args).toContain('-d');
					expect(runRec!.args).toContain('--name');
					expect(runRec!.args).toContain(EXPECTED_NAME);
					expect(runRec!.args).toContain('--entrypoint');
					expect(runRec!.args).toContain('sleep');
					expect(runRec!.args[runRec!.args.length - 1]).toBe('infinity');
					// Two `-v` flags: appDir → /host, ~/.move → /root/.move.
					const vCount = runRec!.args.filter((a) => a === '-v').length;
					expect(vCount).toBe(2);
				}),
			),
		);
	});

	it.effect('adopts an existing running container with the SAME image (no run / no start)', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			// Build a spawner THAT THE PROVIDE BELOW captures by reference,
			// so we can assert on the recorder after the layer-build effect
			// runs. Wrapping in `provideService` would race the recorder
			// with effect-fiber scheduling, hence the closure capture.
			yield* Effect.gen(function* () {
				yield* SuiBuildContainer;
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, { running: true, image: 'devstack/sui:1.71.0' })),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			// The finalizer `docker rm -f <name>` always fires at scope close,
			// so a trailing `rm` is expected. What matters for the adoption
			// branch is that NO `docker run` / NO `docker start` fired (i.e.
			// we adopted the already-healthy container as-is).
			expect(recorder.some((r) => r.args[0] === 'inspect')).toBe(true);
			expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
			expect(recorder.some((r) => r.args[0] === 'start')).toBe(false);
			// The terminal rm is the finalizer; assert it's last (no
			// pre-run rm in this branch).
			const lastDocker = recorder[recorder.length - 1];
			expect(lastDocker?.args[0]).toBe('rm');
		}),
	);

	it.effect('starts a stopped container with the SAME image via `docker start` (no run)', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			yield* Effect.gen(function* () {
				yield* SuiBuildContainer;
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, { running: false, image: 'devstack/sui:1.71.0' })),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			// The shared `ensureContainer` helper passes the container ID
			// to `docker start` (matching Docker.run's pre-E1 behavior);
			// the pre-E1 sui-build code passed the container name. Both
			// are accepted by docker — assert by ID, which is what the
			// helper reads back from the inspect probe.
			expect(recorder.some((r) => r.args[0] === 'start' && r.args[1] === FAKE_EXISTING_ID)).toBe(
				true,
			);
			expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
			// Only `rm` allowed is the finalizer-emitted one at scope
			// close. Pre-run rm would mean we mistook the stopped image
			// for an image-drift and recreated unnecessarily.
			const rms = recorder.filter((r) => r.args[0] === 'rm');
			expect(rms.length).toBe(1);
		}),
	);

	it.effect('rms + recreates when an existing container is running a DIFFERENT image', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			// Inspect returns `running` + `devstack/sui:1.71.0`, but the
			// caller provides `devstack/sui:2.0.0`. The drift forces a
			// `docker rm -f` before the fresh `docker run -d`.
			yield* Effect.gen(function* () {
				yield* SuiBuildContainer;
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, { running: true, image: 'devstack/sui:1.71.0' })),
				Effect.provide(otherImageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			const rmIdx = recorder.findIndex((r) => r.args[0] === 'rm');
			const runIdx = recorder.findIndex((r) => r.args[0] === 'run');
			expect(rmIdx).toBeGreaterThanOrEqual(0);
			expect(runIdx).toBeGreaterThan(rmIdx);
			// Two rms total in this scenario: pre-run drift cleanup +
			// finalizer at scope close.
			expect(recorder.filter((r) => r.args[0] === 'rm').length).toBe(2);
		}),
	);

	it.effect('registers a `docker rm -f` finalizer that fires on scope close', () =>
		Effect.gen(function* () {
			// Build inside a fresh scope and assert that closing the scope
			// fires the rm-f finalizer. Without this finalizer the
			// container would leak between `pnpm dev` sessions.
			const recorder: Array<SpawnRecord> = [];
			yield* Effect.gen(function* () {
				yield* SuiBuildContainer;
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, null)),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			// After Effect.scoped, the finalizer has run.
			const rms = recorder.filter((r) => r.args[0] === 'rm' && r.args.includes(EXPECTED_NAME));
			expect(rms.length).toBeGreaterThanOrEqual(1);
		}),
	);
});

// -----------------------------------------------------------------------------
// SuiBuildContainerLive — lifecycle race recovery (Bugs C + H)
// -----------------------------------------------------------------------------
//
// Programmable spawner: callers supply a per-call response queue keyed
// on the docker verb (`inspect`, `start`, `run`). Each call dequeues the
// next response for that verb; missing entries fall through to the
// "happy" default. Captures the raw argv so the test can assert command
// ordering (e.g. start → fallback run on Bug C; run → fallback start on
// Bug H).

interface ProgrammedResponse {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode: number;
}

const makeProgrammableSpawner = (
	recorder: Array<SpawnRecord>,
	queues: Partial<Record<string, Array<ProgrammedResponse>>>,
) => {
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		const verb = args[0] ?? '';
		const queue = queues[verb];
		if (queue && queue.length > 0) {
			const next = queue.shift()!;
			return { stdout: next.stdout ?? '', stderr: next.stderr ?? '', exitCode: next.exitCode };
		}
		// Fall-through defaults — mirror the happy-path spawner.
		if (verb === 'inspect') return { stdout: '', stderr: 'No such object\n', exitCode: 1 };
		if (verb === 'run') return { stdout: FAKE_RUN_STDOUT, stderr: '', exitCode: 0 };
		return { stdout: '', stderr: '', exitCode: 0 };
	};

	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('unexpected non-standard command in build-container test'));
		}
		recorder.push({ args: [...command.args] });
		const { stdout, stderr, exitCode } = respondTo(command.args);
		const encoder = new TextEncoder();
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(7777),
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

describe('SuiBuildContainerLive — race recovery', () => {
	it.effect(
		'Bug C: falls back to fresh `docker run -d` when `docker start` reports container missing',
		() =>
			Effect.gen(function* () {
				// Inspect observes a stopped container with the matching image,
				// so the layer calls `docker start`. Between observation and
				// start, a prior run's finalizer rm'd the container — `docker
				// start` exits 1 with "No such container: <name>". The layer
				// must fall back to `docker run -d` rather than failing the
				// whole acquire.
				const recorder: Array<SpawnRecord> = [];
				yield* Effect.gen(function* () {
					yield* SuiBuildContainer;
				}).pipe(
					Effect.provide(SuiBuildContainerLive),
					Effect.provide(
						makeProgrammableSpawner(recorder, {
							inspect: [
								{ stdout: `false|devstack/sui:1.71.0|${FAKE_EXISTING_ID}|0\n`, exitCode: 0 },
							],
							start: [
								{
									stderr: `Error response from daemon: No such container: ${EXPECTED_NAME}\n`,
									exitCode: 1,
								},
							],
						}),
					),
					Effect.provide(imageLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);
				const startIdx = recorder.findIndex((r) => r.args[0] === 'start');
				const runIdx = recorder.findIndex((r) => r.args[0] === 'run');
				expect(startIdx).toBeGreaterThanOrEqual(0);
				expect(runIdx).toBeGreaterThan(startIdx);
			}),
	);

	it.effect(
		'Bug C: an unrelated `docker start` failure surfaces as a typed error (no silent fallback)',
		() =>
			Effect.gen(function* () {
				// `docker start` exit 1 with a NON-"no such container" stderr
				// (e.g. daemon connection refused). The layer must NOT silently
				// recreate the container — that would mask a daemon outage.
				const recorder: Array<SpawnRecord> = [];
				const exit = yield* Effect.gen(function* () {
					yield* SuiBuildContainer;
				}).pipe(
					Effect.provide(SuiBuildContainerLive),
					Effect.provide(
						makeProgrammableSpawner(recorder, {
							inspect: [
								{ stdout: `false|devstack/sui:1.71.0|${FAKE_EXISTING_ID}|0\n`, exitCode: 0 },
							],
							start: [
								{
									stderr: `Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n`,
									exitCode: 1,
								},
							],
						}),
					),
					Effect.provide(imageLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
					Effect.exit,
				);
				expect(exit._tag).toBe('Failure');
				// No `docker run` should have fired — the daemon-down stderr
				// is not the "vanished container" race we recover from.
				expect(recorder.some((r) => r.args[0] === 'run')).toBe(false);
			}),
	);

	it.effect(
		'Bug H: falls back to `docker start` when `docker run -d` reports a name collision',
		() =>
			Effect.gen(function* () {
				// Two parallel `up` invocations against the same app race the
				// fresh-create. Our inspect saw nothing → we issue `docker run
				// -d`. The peer beat us and the daemon returns exit 125 with
				// "Conflict. The container name '...' is already in use by
				// container '...'". The layer adopts via `docker start`.
				const recorder: Array<SpawnRecord> = [];
				yield* Effect.gen(function* () {
					yield* SuiBuildContainer;
				}).pipe(
					Effect.provide(SuiBuildContainerLive),
					Effect.provide(
						makeProgrammableSpawner(recorder, {
							// First inspect: returns "no such container" so the
							// helper takes the fresh path. Second inspect: AFTER
							// the collision-recovery `docker start` succeeds the
							// helper re-inspects by name to read the adopted
							// id; return the peer's container.
							inspect: [
								{ stdout: '', stderr: 'No such object\n', exitCode: 1 },
								{
									stdout: `true|devstack/sui:1.71.0|${FAKE_EXISTING_ID}|0\n`,
									exitCode: 0,
								},
							],
							run: [
								{
									stderr: `docker: Error response from daemon: Conflict. The container name "/${EXPECTED_NAME}" is already in use by container "abc123".`,
									exitCode: 125,
								},
							],
							// start succeeds on the fallback (default fall-through ok = exit 0)
						}),
					),
					Effect.provide(imageLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
				);
				const runIdx = recorder.findIndex((r) => r.args[0] === 'run');
				const startIdx = recorder.findIndex((r) => r.args[0] === 'start');
				expect(runIdx).toBeGreaterThanOrEqual(0);
				expect(startIdx).toBeGreaterThan(runIdx);
			}),
	);

	it.effect(
		'Bug H: unrelated `docker run` failures (non-125, non-conflict) still surface as typed errors',
		() =>
			Effect.gen(function* () {
				// Generic daemon failure (e.g. image pull error). Must NOT be
				// masked as a collision — the user needs the real diagnostic.
				const recorder: Array<SpawnRecord> = [];
				const exit = yield* Effect.gen(function* () {
					yield* SuiBuildContainer;
				}).pipe(
					Effect.provide(SuiBuildContainerLive),
					Effect.provide(
						makeProgrammableSpawner(recorder, {
							run: [
								{ stderr: `docker: Error response from daemon: pull access denied.`, exitCode: 1 },
							],
						}),
					),
					Effect.provide(imageLayer),
					Effect.provide(identityLayer),
					Effect.scoped,
					Effect.exit,
				);
				expect(exit._tag).toBe('Failure');
				// No fallback `docker start` should have been attempted.
				expect(recorder.some((r) => r.args[0] === 'start')).toBe(false);
			}),
	);
});

// -----------------------------------------------------------------------------
// runBuild — docker exec invocation
// -----------------------------------------------------------------------------

describe('SuiBuildContainer.runBuild', () => {
	it.effect('issues `docker exec <name> sh -c <inner>` with the translated container path', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			// The runBuild test exercises the no-existing-container branch
			// (inspect returns null → docker run -d), then runs a build.
			// We pass a hostPath under cwd so canExec returns true.
			const hostPath = join(process.cwd(), 'move/mock_usdc');
			yield* Effect.gen(function* () {
				const svc = yield* SuiBuildContainer;
				yield* svc.runBuild(hostPath);
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, null)),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			const execRec = recorder.find((r) => r.args[0] === 'exec');
			expect(execRec).toBeDefined();
			expect(execRec!.args).toContain(EXPECTED_NAME);
			expect(execRec!.args).toContain('sh');
			expect(execRec!.args).toContain('-c');
			const innerScript = execRec!.args[execRec!.args.length - 1];
			expect(innerScript).toContain(`'/host/move/mock_usdc'`);
			expect(innerScript).toContain('sui move build');
			expect(innerScript).toContain('--with-unpublished-dependencies');
		}),
	);

	it.effect('two sequential runBuild calls both succeed (lock released between)', () =>
		Effect.gen(function* () {
			// `SuiBuildContainer.runBuild` no longer holds the move-build
			// lock itself — the lock was hoisted to
			// `engine/sui-cli.ts::buildMove` so it covers all three build
			// paths (host CLI, fresh `docker run --rm`, `docker exec` via
			// this container). This test asserts the unwrapped surface
			// still produces two clean exec invocations back-to-back; the
			// host-wide serialization contract is exercised by the
			// `buildMove concurrent funnel` test in `sui-cli.test.ts`.
			const recorder: Array<SpawnRecord> = [];
			const hostPath = join(process.cwd(), 'move/pkg-a');
			yield* Effect.gen(function* () {
				const svc = yield* SuiBuildContainer;
				yield* svc.runBuild(hostPath);
				yield* svc.runBuild(hostPath);
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, null)),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			const execs = recorder.filter((r) => r.args[0] === 'exec');
			expect(execs.length).toBe(2);
		}),
	);

	it.effect('runBuild fails (typed) for a hostPath outside the bind-mounted app dir', () =>
		Effect.gen(function* () {
			const recorder: Array<SpawnRecord> = [];
			// `/tmp/elsewhere` is not under cwd. canExec returns false and
			// runBuild must fail loudly rather than `docker exec` against a
			// path the container can't see.
			const exit = yield* Effect.gen(function* () {
				const svc = yield* SuiBuildContainer;
				expect(svc.canExec('/tmp/elsewhere/pkg')).toBe(false);
				return yield* Effect.exit(svc.runBuild('/tmp/elsewhere/pkg'));
			}).pipe(
				Effect.provide(SuiBuildContainerLive),
				Effect.provide(makeFakeSpawner(recorder, null)),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			expect(exit._tag).toBe('Failure');
			// No docker exec was issued for the out-of-mount path.
			expect(recorder.some((r) => r.args[0] === 'exec')).toBe(false);
		}),
	);
});
