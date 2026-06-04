// Subprocess output capture — one variant, one error.
//
// One spawn-and-capture surface parameterised by options, covering both
// the fail-on-nonzero and streaming-observer cases that would otherwise
// be separate helpers.
//
// Surface:
//
//   capture(spawner, cmd, opts) -> Effect<CaptureResult, CaptureError>
//
//   - Always returns `CaptureResult` for zero AND non-zero exits when
//     `opts.nonZeroIsFailure` is unset (or `false`). The caller decides.
//   - With `opts.nonZeroIsFailure: true` the Effect fails with
//     `CaptureError` carrying `exitCode` on non-zero exit.
//   - With `opts.onStdoutLine` set, each stdout line is emitted to the
//     callback as it arrives (line-buffered across chunk boundaries).
//     The full stdout is still returned in `CaptureResult.stdout` so
//     the error envelope downstream stays uniform.
//   - With `opts.onStderrLine` set, same shape for stderr (motivated
//     by the L1 per-line sink that promotes WARN/ERROR markers — see
//     architecture L1 § "Shared per-line streaming sink").
//
// One error class for every failure mode (spawner failure, non-zero
// exit when promoted). The `op` tag attributes the failure to a
// specific subprocess invocation; downstream wrappers route this into
// their own envelopes via `Effect.mapError`.

import { Effect, Stream } from 'effect';
import { Data } from 'effect';
import type { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner } from 'effect/unstable/process';

import { splitUtf8Lines } from './process-lines.ts';

// -----------------------------------------------------------------------------
// Single error class
// -----------------------------------------------------------------------------

/**
 * The one subprocess-capture error class. Two failure modes:
 *
 *   (a) Spawner failure (binary missing, fork limit, pipe setup). The
 *       `cause` field carries the spawner's raw failure; `exitCode` is
 *       undefined.
 *   (b) Non-zero exit when `opts.nonZeroIsFailure` was true. The
 *       `exitCode`, `stdout`, `stderr` fields are populated;
 *       `cause` is undefined.
 *
 * Downstream wrappers (plugins) wrap this with their own envelopes via
 * `Effect.mapError`. The `op` field carries through so the failure
 * attribution survives.
 */
export class CaptureError extends Data.TaggedError('CaptureError')<{
	readonly op: string;
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly cause?: unknown;
}> {}

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface CaptureResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CaptureOptions {
	/**
	 * Caller-supplied tag identifying the subprocess invocation. Embedded
	 * in any `CaptureError` so downstream envelopes have stable
	 * attribution. Defaults to the command's `command` field when absent.
	 */
	readonly op?: string;
	/**
	 * Maximum stderr bytes preserved on a captured-error path. Past the
	 * limit, the surplus is dropped and `…[truncated]` is appended.
	 * Default 500 (a tight bound; common case is a TUI row that must fit
	 * one line).
	 */
	readonly stderrTruncate?: number;
	/**
	 * Maximum stdout bytes preserved on a captured-error path. Default
	 * `Infinity` — most callers want full stdout for parsing.
	 */
	readonly stdoutTruncate?: number;
	/**
	 * Promote a non-zero exit code into a `CaptureError`. The error
	 * carries the captured stdout/stderr verbatim. Default `false` (the
	 * caller decides).
	 */
	readonly nonZeroIsFailure?: boolean;
	/**
	 * Per-line stdout observer. Lines are buffered across chunk boundaries
	 * via `Stream.splitLines`. Callback errors are ignored (the capture
	 * must never abort because narration failed).
	 */
	readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
	/**
	 * Per-line stderr observer. Same semantics as `onStdoutLine`. The L1
	 * shared per-line sink (level promotion: stderr lines containing
	 * `WARN`/`ERROR` markers) routes through here.
	 */
	readonly onStderrLine?: (line: string) => Effect.Effect<void>;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_STDERR_TRUNC = 500;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const truncateTo = (text: string, limit: number): string => {
	if (!Number.isFinite(limit) || text.length <= limit) return text;
	return `${text.slice(0, limit)}…[truncated]`;
};

const opOf = (cmd: ChildProcess.Command, override: string | undefined): string => {
	if (override !== undefined) return override;
	if (cmd._tag === 'StandardCommand') return cmd.command;
	return 'piped-command';
};

type SpawnerService = ReturnType<typeof ChildProcessSpawner.make>;

const drainObserved = <E>(
	stream: Stream.Stream<Uint8Array, E>,
	observer: ((line: string) => Effect.Effect<void>) | undefined,
): Effect.Effect<string, E> => {
	if (!observer) {
		return Stream.mkString(Stream.decodeText(stream));
	}
	const lines = splitUtf8Lines(stream).pipe(
		Stream.tap((line) => observer(line).pipe(Effect.ignore)),
	);
	// Re-fold lines into the full stdout/stderr string. We don't append
	// a trailing newline — mirrors the non-observed path so the captured
	// error shape is uniform regardless of whether an observer was set.
	return Stream.runFold(
		lines,
		() => '',
		(acc, line) => (acc.length === 0 ? line : `${acc}\n${line}`),
	);
};

// -----------------------------------------------------------------------------
// The one capture function
// -----------------------------------------------------------------------------

/**
 * Spawn `cmd`, drain stdout + stderr + exit code concurrently. Returns
 * the captured result, or fails with `CaptureError` if the spawner
 * itself failed (or if `nonZeroIsFailure` was set and the child exited
 * non-zero).
 *
 * One function. One error class. Stream observers are opt-in via
 * `opts.onStdoutLine` / `opts.onStderrLine`; the streaming and
 * non-streaming paths share this single function.
 */
export const capture = (
	spawner: SpawnerService,
	cmd: ChildProcess.Command,
	opts?: CaptureOptions,
): Effect.Effect<CaptureResult, CaptureError> => {
	const op = opOf(cmd, opts?.op);
	const stderrLimit = opts?.stderrTruncate ?? DEFAULT_STDERR_TRUNC;
	const stdoutLimit = opts?.stdoutTruncate ?? Infinity;
	const nonZeroIsFailure = opts?.nonZeroIsFailure ?? false;
	const onStdoutLine = opts?.onStdoutLine;
	const onStderrLine = opts?.onStderrLine;
	const mapSpawn = (cause: unknown): CaptureError =>
		new CaptureError({ op, stdout: '', stderr: '', cause });

	return Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawn));
			const [stdoutText, stderrText, code] = yield* Effect.all(
				[
					drainObserved(handle.stdout, onStdoutLine).pipe(Effect.mapError(mapSpawn)),
					drainObserved(handle.stderr, onStderrLine).pipe(Effect.mapError(mapSpawn)),
					handle.exitCode.pipe(Effect.mapError(mapSpawn)),
				],
				{ concurrency: 'unbounded' },
			);
			const result: CaptureResult = {
				exitCode: code as number,
				stdout: truncateTo(stdoutText, stdoutLimit),
				stderr: truncateTo(stderrText, stderrLimit),
			};
			if (nonZeroIsFailure && result.exitCode !== 0) {
				return yield* Effect.fail(
					new CaptureError({
						op,
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					}),
				);
			}
			return result;
		}),
	);
};
