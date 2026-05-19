// Contract pins for the shared spawn → drain → exitCode helper added by
// audit finding E2. The legacy three-way duplication (`docker/core.ts::
// runCapturing`, `sui-cli.ts::runWithCapture`, `snapshot.ts::runTar`)
// now all route through `captureCommand`; these tests cover the
// invariants the three wrappers depend on:
//
//   - exit 0 returns the captured stdout / stderr verbatim
//   - non-zero exit still resolves (no auto-fail) — wrappers branch on
//     `result.exitCode` themselves
//   - `captureCommandOrFail` DOES promote non-zero exit to a CaptureError
//   - stderr truncation respects the `stderrTruncate` option
//   - spawn failure (ENOENT-style) becomes a `CaptureError` with empty
//     streams and the spawner's raw cause attached

import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import { captureCommand, captureCommandOrFail, CaptureError } from './capture-command.js';

interface FakeResponse {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

// Build a `ChildProcessSpawner` layer that returns the canned response
// for every `spawn` call. Equivalent in shape to the docker.test.ts
// fixture but trimmed to what these unit tests need.
const makeSpawnerLayer = (response: FakeResponse) => {
	const spawn = (_command: ChildProcess.Command) => {
		const encoder = new TextEncoder();
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(1234),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout:
				response.stdout.length > 0 ? Stream.succeed(encoder.encode(response.stdout)) : Stream.empty,
			stderr:
				response.stderr.length > 0 ? Stream.succeed(encoder.encode(response.stderr)) : Stream.empty,
			all: Stream.empty,
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

// Spawner that fails before the child is reachable — mirrors the
// real ENOENT path (`docker` not on PATH, `sui` not installed). The
// CaptureError's `cause` carries the spawner's raw error.
class FakeSpawnFailure extends Error {
	constructor() {
		super('ENOENT — fake binary not found');
		this.name = 'FakeSpawnFailure';
	}
}

// Spawn that immediately fails. We have to cast to the
// `PlatformError`-channel that the upstream Tag declares — our
// `FakeSpawnFailure` carries the same `{cause}` semantics callers
// expect on ENOENT but isn't an actual `PlatformError`. The cast is
// safe because `captureCommand`'s only contract is "spawn errors flow
// into the CaptureError cause" which holds regardless of the cause's
// concrete type.
const failingSpawnerLayer = () => {
	const spawn = ((_command: ChildProcess.Command) =>
		Effect.fail(new FakeSpawnFailure())) as unknown as ChildProcessSpawner.ChildProcessSpawner['Service']['spawn'];
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

describe('captureCommand', () => {
	it.effect('returns the captured streams verbatim on a zero-exit run', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommand(
				spawner,
				ChildProcess.make('echo', ['hello']),
				{ op: 'echo' },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe('hello world\n');
			expect(result.stderr).toBe('');
		}).pipe(
			Effect.provide(makeSpawnerLayer({ stdout: 'hello world\n', stderr: '', exitCode: 0 })),
		),
	);

	it.effect('does NOT auto-fail on a non-zero exit (caller branches on result.exitCode)', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommand(spawner, ChildProcess.make('false', []), {
				op: 'docker run',
			});
			expect(result.exitCode).toBe(125);
			expect(result.stdout).toBe('');
			expect(result.stderr).toBe('docker: error during connect\n');
		}).pipe(
			Effect.provide(
				makeSpawnerLayer({
					stdout: '',
					stderr: 'docker: error during connect\n',
					exitCode: 125,
				}),
			),
		),
	);

	it.effect('applies stderr truncation when `stderrTruncate` is set', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const longStderr = 'x'.repeat(1500);
			const result = yield* captureCommand(spawner, ChildProcess.make('tar', ['-cf', 'x.tar']), {
				op: 'tar',
				stderrTruncate: 500,
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr.length).toBe(500 + '…[truncated]'.length);
			expect(result.stderr.endsWith('…[truncated]')).toBe(true);
			// First 500 chars survive unchanged.
			expect(result.stderr.slice(0, 500)).toBe(longStderr.slice(0, 500));
		}).pipe(
			Effect.provide(
				makeSpawnerLayer({ stdout: '', stderr: 'x'.repeat(1500), exitCode: 2 }),
			),
		),
	);

	it.effect('Infinity truncation preserves the full stream verbatim', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const longStderr = 'x'.repeat(2000);
			const result = yield* captureCommand(spawner, ChildProcess.make('docker', ['inspect']), {
				op: 'docker inspect',
				stderrTruncate: Infinity,
			});
			expect(result.stderr).toBe(longStderr);
		}).pipe(
			Effect.provide(
				makeSpawnerLayer({ stdout: '', stderr: 'x'.repeat(2000), exitCode: 0 }),
			),
		),
	);

	it.effect(
		'spawn failure becomes a CaptureError with empty streams + the spawner cause',
		() =>
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const result = yield* captureCommand(
					spawner,
					ChildProcess.make('docker', ['ps']),
					{ op: 'docker ps' },
				).pipe(Effect.flip);
				expect(result).toBeInstanceOf(CaptureError);
				expect(result.op).toBe('docker ps');
				expect(result.stdout).toBe('');
				expect(result.stderr).toBe('');
				expect(result.exitCode).toBeUndefined();
				expect(result.cause).toBeInstanceOf(FakeSpawnFailure);
			}).pipe(Effect.provide(failingSpawnerLayer())),
	);

	it.effect('falls back to `cmd.command` for `op` when no override is provided', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommand(spawner, ChildProcess.make('docker', ['ps'])).pipe(
				Effect.flip,
			);
			expect(result.op).toBe('docker');
		}).pipe(Effect.provide(failingSpawnerLayer())),
	);
});

describe('captureCommandOrFail', () => {
	it.effect('promotes a non-zero exit into a CaptureError carrying the streams', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandOrFail(
				spawner,
				ChildProcess.make('docker', ['build']),
				{ op: 'docker build' },
			).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CaptureError);
			expect(result.op).toBe('docker build');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe('Error: missing tag\n');
			expect(result.cause).toBeUndefined();
		}).pipe(
			Effect.provide(
				makeSpawnerLayer({ stdout: '', stderr: 'Error: missing tag\n', exitCode: 1 }),
			),
		),
	);

	it.effect('passes through a zero-exit success unchanged', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandOrFail(
				spawner,
				ChildProcess.make('docker', ['version']),
				{ op: 'docker version' },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe('Docker version 99.0.0\n');
		}).pipe(
			Effect.provide(
				makeSpawnerLayer({ stdout: 'Docker version 99.0.0\n', stderr: '', exitCode: 0 }),
			),
		),
	);
});
