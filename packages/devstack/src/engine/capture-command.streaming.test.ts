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

import { Effect, Layer, Ref, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from '@effect/vitest';
import {
	captureCommand,
	captureCommandOrFail,
	captureCommandStreaming,
	captureCommandStreamingOrFail,
	CaptureError,
} from './capture-command.js';

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
		Effect.fail(
			new FakeSpawnFailure(),
		)) as unknown as ChildProcessSpawner.ChildProcessSpawner['Service']['spawn'];
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

describe('captureCommand', () => {
	it.effect('returns the captured streams verbatim on a zero-exit run', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommand(spawner, ChildProcess.make('echo', ['hello']), {
				op: 'echo',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe('hello world\n');
			expect(result.stderr).toBe('');
		}).pipe(Effect.provide(makeSpawnerLayer({ stdout: 'hello world\n', stderr: '', exitCode: 0 }))),
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
			Effect.provide(makeSpawnerLayer({ stdout: '', stderr: 'x'.repeat(1500), exitCode: 2 })),
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
			Effect.provide(makeSpawnerLayer({ stdout: '', stderr: 'x'.repeat(2000), exitCode: 0 })),
		),
	);

	it.effect('spawn failure becomes a CaptureError with empty streams + the spawner cause', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommand(spawner, ChildProcess.make('docker', ['ps']), {
				op: 'docker ps',
			}).pipe(Effect.flip);
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
			const result = yield* captureCommandOrFail(spawner, ChildProcess.make('docker', ['build']), {
				op: 'docker build',
			}).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CaptureError);
			expect(result.op).toBe('docker build');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe('Error: missing tag\n');
			expect(result.cause).toBeUndefined();
		}).pipe(
			Effect.provide(makeSpawnerLayer({ stdout: '', stderr: 'Error: missing tag\n', exitCode: 1 })),
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

// Spawner whose stdout arrives in multiple chunks (deliberately split
// across a `\n` boundary so the `splitLines` buffering inside
// `captureCommandStreaming` actually has to glue them). Used by the
// streaming tests to assert that the per-line callback sees clean lines
// even when the byte stream chunks them mid-line.
const makeChunkedSpawnerLayer = (
	stdoutChunks: ReadonlyArray<string>,
	stderr: string = '',
	exitCode: number = 0,
) => {
	const spawn = (_command: ChildProcess.Command) => {
		const encoder = new TextEncoder();
		const handle = ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(1234),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain as never,
			stdout:
				stdoutChunks.length > 0
					? Stream.fromIterable(stdoutChunks.map((c) => encoder.encode(c)))
					: Stream.empty,
			stderr: stderr.length > 0 ? Stream.succeed(encoder.encode(stderr)) : Stream.empty,
			all: Stream.empty,
			getInputFd: () => Sink.drain as never,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		});
		return Effect.succeed(handle);
	};
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

describe('captureCommandStreaming', () => {
	it.effect('invokes onStdoutLine once per stdout line, in order', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const seen = yield* Ref.make<ReadonlyArray<string>>([]);
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: (line) => Ref.update(seen, (xs) => [...xs, line]),
				},
			);
			expect(result.exitCode).toBe(0);
			const observed = yield* Ref.get(seen);
			expect(observed).toEqual(['line 1', 'line 2', 'line 3']);
		}).pipe(
			Effect.provide(makeChunkedSpawnerLayer(['line 1\nline 2\n', 'line 3\n'])),
		),
	);

	it.effect('glues lines across chunk boundaries via splitLines', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const seen = yield* Ref.make<ReadonlyArray<string>>([]);
			yield* captureCommandStreaming(spawner, ChildProcess.make('docker', ['pull', 'foo']), {
				op: 'docker pull',
				onStdoutLine: (line) => Ref.update(seen, (xs) => [...xs, line]),
			});
			const observed = yield* Ref.get(seen);
			// "abc\n" + "def\n" reconstructed across chunks → ['abc', 'def'].
			// If the helper called the callback per-chunk, we'd see partial
			// lines like 'ab' / 'cdef' instead.
			expect(observed).toEqual(['abc', 'def']);
		}).pipe(Effect.provide(makeChunkedSpawnerLayer(['ab', 'c\nde', 'f\n']))),
	);

	it.effect('still folds the full stdout into CaptureResult.stdout', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
				},
			);
			// `Stream.runFold` joins lines with `\n`; the trailing newline
			// the child emitted is consumed by splitLines, so the captured
			// stdout has lines joined but no trailing `\n`. This matches
			// what's documented on `captureCommandStreaming`.
			expect(result.stdout).toBe('line 1\nline 2\nline 3');
		}).pipe(
			Effect.provide(makeChunkedSpawnerLayer(['line 1\nline 2\nline 3\n'])),
		),
	);

	it.effect('passes stderr through whole-string drain (matches captureCommand)', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
					stderrTruncate: Infinity,
				},
			);
			expect(result.stderr).toBe('daemon error: nope\n');
		}).pipe(
			Effect.provide(makeChunkedSpawnerLayer([''], 'daemon error: nope\n', 0)),
		),
	);

	it.effect('non-zero exit returns the CaptureResult without auto-failing', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
				},
			);
			expect(result.exitCode).toBe(125);
		}).pipe(
			Effect.provide(makeChunkedSpawnerLayer(['anything\n'], 'failed\n', 125)),
		),
	);

	it.effect('a callback that fails does NOT abort the capture', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			// Callback that always fails. The streaming variant must
			// `Effect.ignore` callback errors — narration is observation,
			// never load-bearing.
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.fail('callback exploded' as never),
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe('line 1\nline 2');
		}).pipe(Effect.provide(makeChunkedSpawnerLayer(['line 1\nline 2\n']))),
	);

	it.effect('spawn failure becomes a CaptureError with empty streams', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreaming(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
				},
			).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CaptureError);
			expect(result.op).toBe('docker pull');
			expect(result.stdout).toBe('');
			expect(result.stderr).toBe('');
			expect(result.exitCode).toBeUndefined();
		}).pipe(Effect.provide(failingSpawnerLayer())),
	);
});

describe('captureCommandStreamingOrFail', () => {
	it.effect('promotes a non-zero exit into a CaptureError carrying the streams', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreamingOrFail(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
				},
			).pipe(Effect.flip);
			expect(result).toBeInstanceOf(CaptureError);
			expect(result.op).toBe('docker pull');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe('boom\n');
		}).pipe(Effect.provide(makeChunkedSpawnerLayer([''], 'boom\n', 1))),
	);

	it.effect('passes through a zero-exit success unchanged', () =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const result = yield* captureCommandStreamingOrFail(
				spawner,
				ChildProcess.make('docker', ['pull', 'foo']),
				{
					op: 'docker pull',
					onStdoutLine: () => Effect.void,
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe('ok');
		}).pipe(Effect.provide(makeChunkedSpawnerLayer(['ok\n']))),
	);
});
