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
import { join } from 'node:path';
import { Identity } from './identity.js';
import { SuiBuildImage } from './sui-cli.js';
import {
	SuiBuildContainer,
	SuiBuildContainerLive,
	containerNameFor,
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
		expect(out).toBe(
			'/host/.devstack/imports/mystenlabs_deepbookv3@v7.0.0/packages/deepbook',
		);
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

const makeFakeSpawner = (
	recorder: Array<SpawnRecord>,
	inspect: InspectResponse | null,
) => {
	const respondTo = (
		args: ReadonlyArray<string>,
	): { stdout: string; stderr: string; exitCode: number } => {
		if (args[0] === 'inspect') {
			if (inspect === null) return { stdout: '', stderr: 'No such object\n', exitCode: 1 };
			return {
				stdout: `${inspect.running}|${inspect.image}\n`,
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
				Effect.provide(
					makeFakeSpawner(recorder, { running: true, image: 'devstack/sui:1.71.0' }),
				),
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
				Effect.provide(
					makeFakeSpawner(recorder, { running: false, image: 'devstack/sui:1.71.0' }),
				),
				Effect.provide(imageLayer),
				Effect.provide(identityLayer),
				Effect.scoped,
			);
			expect(recorder.some((r) => r.args[0] === 'start' && r.args[1] === EXPECTED_NAME)).toBe(
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
				Effect.provide(
					makeFakeSpawner(recorder, { running: true, image: 'devstack/sui:1.71.0' }),
				),
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
