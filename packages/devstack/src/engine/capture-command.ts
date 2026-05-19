// Shared subprocess spawn → drain → exit-code helper. Audit finding E2.
//
// Before this module, `engine/docker/core.ts::runCapturing`,
// `engine/sui-cli.ts::runWithCapture`, and `engine/snapshot.ts::runTar`
// each carried their own copy of "spawn the command, drain stdout +
// stderr + exitCode concurrently, map any spawner error into a domain
// error". The three implementations also each carried their own
// truncation policy (1024 / 600 / 500 bytes), their own `decodeStream`
// helper, and their own error-mapping shape — meaning a fix to one
// (e.g. "empty stderr should render as `(empty)`") had to be remembered
// in three places.
//
// This module owns the actual subprocess plumbing exactly once. The
// three legacy wrappers now collapse to a single `Effect.mapError`
// call each: the public `DockerError` / `SuiCliError` / `SnapshotError`
// envelopes are unchanged, but their implementations route through
// `captureCommand`.
//
// Design notes:
//   - Returns a `CaptureResult` for both zero AND non-zero exits; the
//     caller decides whether `exitCode !== 0` is fatal. This matches
//     the docker primitives (some of which want to inspect non-zero
//     stderr, e.g. `pg_isready` retry probes) and keeps the spawn-
//     vs-non-zero-exit distinction structured rather than collapsed
//     into a generic "subprocess failed" error.
//   - The spawn-failure-only `CaptureError` carries the operation tag,
//     the spawner's raw cause, and a snapshot of any captured stderr
//     so downstream error envelopes have something useful to render.
//     stderr is bounded by `stderrTruncate` (default 500 bytes — the
//     legacy snapshot/sui-cli policy, which is the tightest of the
//     three and the most common one for a TUI row).
//   - `captureCommandOrFail` is the "or-fail-on-non-zero-exit" variant
//     used by docker's `runCapturingOrFail` and equivalent — the
//     non-zero-exit case becomes a CaptureError with `exitCode` set.

import { Effect, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

// `ChildProcessSpawner.make` returns the bare Service shape (the
// fields the Service-class wraps), not the Tag class itself. Most
// devstack callers pass the `make`-derived value through directly
// (so they can stub the spawner in tests without going through
// `ChildProcessSpawner.of`), so the helper accepts that shape.
type SpawnerService = ReturnType<typeof ChildProcessSpawner.make>;

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

/**
 * Raised by `captureCommand` when either:
 *
 *   (a) the spawner itself failed (e.g. ENOENT for the binary, fork
 *       limit exceeded). `exitCode` is `undefined`; `stdout` / `stderr`
 *       are empty strings; `cause` carries the spawner's raw failure.
 *
 *   (b) `captureCommandOrFail` ran and the child exited non-zero.
 *       `exitCode` is set; `stdout` / `stderr` are the (possibly
 *       truncated) captured streams; `cause` is undefined.
 *
 * Per-callsite wrappers (`DockerError`, `SuiCliError`, `SnapshotError`)
 * map this into their own envelope via `Effect.mapError`. The `op` tag
 * carries forward into those envelopes so the failure can still be
 * attributed to a specific subprocess invocation.
 */
export class CaptureError extends Schema.TaggedErrorClass<CaptureError>()('CaptureError', {
	/**
	 * Caller-supplied tag identifying which subprocess invocation failed
	 * (e.g. `'docker run'`, `'sui move build'`, `'tar -cf ...'`). Wrappers
	 * route this into their own `phase` / context strings.
	 */
	op: Schema.String,
	exitCode: Schema.optional(Schema.Number),
	stdout: Schema.String,
	stderr: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

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
	 * in any `CaptureError` raised by this call so downstream error
	 * envelopes have a stable attribution string. Defaults to the
	 * command's `command` field if absent.
	 */
	readonly op?: string;
	/**
	 * Maximum stderr bytes preserved on a captured-error path. Past the
	 * limit, the surplus is dropped and `…[truncated]` is appended.
	 * Default 500 (matches the legacy snapshot/sui-cli policy — the
	 * narrowest of the three, and the one a TUI row can realistically
	 * render). Set to `Infinity` to opt out of truncation entirely.
	 */
	readonly stderrTruncate?: number;
	/**
	 * Maximum stdout bytes preserved on a captured-error path. Default
	 * `Infinity` (no truncation) — most callers want the full stdout
	 * for parsing (e.g. `docker inspect`'s JSON blob), and a non-zero
	 * exit with an interesting stdout is rare enough that we don't
	 * default to clipping it.
	 */
	readonly stdoutTruncate?: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const DEFAULT_STDERR_TRUNC = 500;

/** Drain a UTF-8 byte stream into a single string. Exported because
 * `engine/docker/exec.ts` needs it directly for the per-line / one-shot
 * branching path that doesn't fit `captureCommand`'s "both streams at
 * once" shape. */
export const decodeStream = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
	Stream.mkString(Stream.decodeText(stream));

const truncateTo = (text: string, limit: number): string => {
	if (!Number.isFinite(limit) || text.length <= limit) return text;
	return `${text.slice(0, limit)}…[truncated]`;
};

const opOf = (cmd: ChildProcess.Command, override: string | undefined): string => {
	if (override !== undefined) return override;
	if (cmd._tag === 'StandardCommand') return cmd.command;
	// Piped commands don't have a single `command` — fall back to a
	// stable label so `CaptureError.op` is never empty.
	return 'piped-command';
};

// -----------------------------------------------------------------------------
// captureCommand
// -----------------------------------------------------------------------------

/**
 * Spawn `cmd`, drain stdout + stderr + exit code concurrently. Returns
 * the captured result even on non-zero exit — callers that want to
 * promote non-zero exits into errors use `captureCommandOrFail`.
 *
 * The only failure mode this Effect models is "the spawner itself
 * could not start or wait on the process" (ENOENT, fork limits, pipe
 * setup failures). Those land as `CaptureError({op, cause})` with
 * `exitCode` undefined.
 */
export const captureCommand = (
	spawner: SpawnerService,
	cmd: ChildProcess.Command,
	opts?: CaptureOptions,
): Effect.Effect<CaptureResult, CaptureError> => {
	const op = opOf(cmd, opts?.op);
	const stderrLimit = opts?.stderrTruncate ?? DEFAULT_STDERR_TRUNC;
	const stdoutLimit = opts?.stdoutTruncate ?? Infinity;
	const mapSpawn = (cause: unknown): CaptureError =>
		new CaptureError({ op, stdout: '', stderr: '', cause });
	return Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawn));
			const [stdoutText, stderrText, code] = yield* Effect.all(
				[
					decodeStream(handle.stdout).pipe(Effect.mapError(mapSpawn)),
					decodeStream(handle.stderr).pipe(Effect.mapError(mapSpawn)),
					handle.exitCode.pipe(Effect.mapError(mapSpawn)),
				],
				{ concurrency: 'unbounded' },
			);
			return {
				exitCode: code as number,
				stdout: truncateTo(stdoutText, stdoutLimit),
				stderr: truncateTo(stderrText, stderrLimit),
			};
		}),
	);
};

/**
 * `captureCommand` variant that promotes a non-zero exit into a
 * `CaptureError`. Used by callers that don't want to branch on
 * `exitCode` themselves (the "happy path returns stdout" shape).
 */
export const captureCommandOrFail = (
	spawner: SpawnerService,
	cmd: ChildProcess.Command,
	opts?: CaptureOptions,
): Effect.Effect<CaptureResult, CaptureError> => {
	const op = opOf(cmd, opts?.op);
	return Effect.gen(function* () {
		const result = yield* captureCommand(spawner, cmd, opts);
		if (result.exitCode !== 0) {
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
	});
};
