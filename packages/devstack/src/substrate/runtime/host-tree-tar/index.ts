// host-tree-tar — stream a host filesystem subtree as a tar archive.
//
// Architecture §"Substrate primitives roster" (Open slot O21):
// snapshot orchestrator hard-fails today on the `tarHostTree` /
// `untarHostTree` stubs. This primitive fills the slot.
//
// Design:
//   - Stream-based — `tarHostTree` returns a `Stream<Uint8Array>`;
//     `untarHostTree` consumes one. The entire tree NEVER materialises
//     in memory (snapshot trees can hold gigabytes of cache state).
//   - Mode-preserving — the snapshot orchestrator carries 0o600 /
//     0o700 mode bits on secret material (postgres keys, account
//     keystores). System `tar -p` (extract) and `tar --no-recursion`
//     (control) preserve them natively. We do NOT roll our own
//     archive writer (a TypeScript-side reimplementation would have
//     to track POSIX mode flags + extended attributes; system tar is
//     correct by default).
//   - Subprocess-based — spawn `tar` (BSD-tar on macOS, GNU-tar on
//     Linux); both honour the flags used here (`-c` / `-x` / `-f -`).
//     Exit code != 0 surfaces as `TarSpawnFailed`.
//
// Boundary:
//   - Substrate-level: this is a generic filesystem primitive; no
//     plugin names referenced.
//   - The caller controls which subtrees are archived (snapshot
//     orchestrator passes a list of relative paths under a parent
//     dir). Permission preservation is unconditional.

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

import { Effect, Schema, Scope, Stream } from 'effect';

import {
	awaitProcessExit,
	describeProcessExitStatus,
	type ManagedProcessChild,
	type ManagedProcessExitStatus,
} from '../process-supervisor.ts';
import {
	finishTarReader,
	isSafeArchivePath,
	makeTarReaderState,
	processTarChunk,
	skipEntry,
	type TarEntry,
	type TarEntryDirective,
} from '../tar/reader.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Tagged failure during tar / untar. `stage` discriminates the
 *  precise step (spawn vs stream-read vs exit-code).
 *
 *  `cause` carries the underlying error verbatim; the cascade
 *  formatter walks it. */
export class HostTreeTarError extends Schema.TaggedErrorClass<HostTreeTarError>()(
	'HostTreeTarError',
	{
		stage: Schema.Literals([
			'spawn',
			'stream-stdout',
			'stream-stdin',
			'exit-code',
			'entry-validation',
			'no-subtrees',
		]),
		operation: Schema.Literals(['tar', 'untar']),
		detail: Schema.String,
		/** Captured stderr from the `tar` subprocess (last ~4 KB). */
		stderrTail: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect),
	},
) {}

// ---------------------------------------------------------------------------
// Tar one or more subtrees → Stream<Uint8Array>
// ---------------------------------------------------------------------------

/** Spec for `tarHostTree`.
 *
 *  - `parentDir`: directory the relative paths are anchored under.
 *    `tar -C <parentDir>` runs the archive with this as cwd, so the
 *    archive entries are stored relative to `parentDir`.
 *  - `relPaths`: subtree paths relative to `parentDir`. Empty list
 *    fails fast (`stage: 'no-subtrees'`) — the caller is responsible
 *    for the host-tree-included guard. */
export interface TarHostTreeSpec {
	readonly parentDir: string;
	readonly relPaths: ReadonlyArray<string>;
}

const TAR_STDERR_TAIL_BYTES = 4096;

const collectStderrTail = (chunks: Array<Uint8Array>): string => {
	if (chunks.length === 0) return '';
	let total = 0;
	for (let i = chunks.length - 1; i >= 0; i--) {
		total += chunks[i]!.length;
		if (total >= TAR_STDERR_TAIL_BYTES) break;
	}
	const bytes = Buffer.concat(chunks);
	return bytes.subarray(Math.max(0, bytes.length - TAR_STDERR_TAIL_BYTES)).toString('utf8');
};

const tarExitError = (
	operation: 'tar' | 'untar',
	status: ManagedProcessExitStatus,
	stderrChunks: Array<Uint8Array>,
): HostTreeTarError =>
	new HostTreeTarError({
		stage: 'exit-code',
		operation,
		exitCode: status.code ?? -1,
		detail: `'tar' exited with ${describeProcessExitStatus(status)}`,
		stderrTail: collectStderrTail(stderrChunks),
	});

/** Spawn `tar` with a bounded stderr ring buffer and a SIGKILL-on-
 *  scope-close finalizer. Both `tarHostTree` and `untarHostTree` share
 *  this body verbatim — only the args, stdio direction (which pipe is
 *  the data channel), and the `operation` tag differ. The data pipe
 *  (`stdout` for tar, `stdin` for untar) is read off the returned
 *  `child` by the caller; stderr is always piped so the exit-code
 *  failure can carry the captured tail.
 *
 *  The stderr listener is removed and a live child is killed on scope
 *  close — the finalizer binds to the surrounding Scope (the stream's
 *  lifecycle for tar, the consuming Effect's for untar). */
const spawnTar = (
	operation: 'tar' | 'untar',
	args: ReadonlyArray<string>,
	stdio: StdioOptions,
): Effect.Effect<
	{ readonly child: ChildProcess; readonly stderrChunks: Array<Uint8Array> },
	HostTreeTarError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const child = yield* Effect.try({
			try: () => spawn('tar', [...args], { stdio }),
			catch: (cause) =>
				new HostTreeTarError({
					stage: 'spawn',
					operation,
					detail: `failed to spawn 'tar ${args.join(' ')}'`,
					cause,
				}),
		});

		// Stderr collection lives outside the data stream — we accumulate
		// the tail so an exit-code failure carries actionable context. The
		// stderr listener is removed on scope close.
		const stderrChunks: Array<Uint8Array> = [];
		const onStderr = (chunk: Buffer): void => {
			stderrChunks.push(chunk);
			if (stderrChunks.length > 256) stderrChunks.splice(0, stderrChunks.length - 256);
		};
		child.stderr?.on('data', onStderr);

		// Finalise the subprocess on scope close: kill if alive, drop
		// listeners either way.
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				child.stderr?.off('data', onStderr);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill('SIGKILL');
				}
			}),
		);

		return { child, stderrChunks };
	});

const tarValidationError = (detail: string): HostTreeTarError =>
	new HostTreeTarError({
		stage: 'entry-validation',
		operation: 'untar',
		detail,
	});

// Host-tree-specific validation layer on top of the shared tar reader.
// The reader resolves entries (pax/gnu paths applied); this hook
// rejects unsafe entry paths and unsafe hardlink/symlink targets, then
// skips the body. The reader owns the block discipline and pax/gnu
// parsing; the validator never reads file content.
const hostTreeValidationHooks = {
	onEntry: (entry: TarEntry): TarEntryDirective | HostTreeTarError => {
		if (!isSafeArchivePath(entry.path)) {
			return tarValidationError(`unsafe tar entry path: ${entry.path}`);
		}
		if ((entry.typeflag === '1' || entry.typeflag === '2') && !isSafeArchivePath(entry.linkPath)) {
			return tarValidationError(`unsafe tar link target: ${entry.linkPath}`);
		}
		return skipEntry();
	},
	onExtendedError: (detail: string): HostTreeTarError =>
		tarValidationError(
			detail === 'global pax path/linkpath records are not supported'
				? 'global pax path/linkpath records are not supported in snapshots'
				: detail,
		),
} as const;

export const validateHostTreeTarEntries = <R>(
	stream: Stream.Stream<Uint8Array, HostTreeTarError, R>,
): Effect.Effect<void, HostTreeTarError, R> =>
	Effect.gen(function* () {
		const state = makeTarReaderState();
		yield* Stream.runForEach(stream, (chunk) => {
			const error = processTarChunk(state, chunk, hostTreeValidationHooks);
			return error === null ? Effect.void : Effect.fail(error);
		});
		const finalError = finishTarReader(state, tarValidationError);
		if (finalError !== null) return yield* Effect.fail(finalError);
	});

/**
 * Stream the tar archive of `relPaths` (relative to `parentDir`) as a
 * `Stream<Uint8Array>`. Mode bits are preserved.
 *
 * The subprocess is bound to the consuming Scope: closing the scope
 * before the stream finishes kills the subprocess and surfaces
 * `stream-stdout` if the consumer was mid-read.
 *
 * Caller consumes via `Stream.run(...)` — e.g. pipe to a file via
 * `Stream.run(stream, Sink.fromWritable(() => createWriteStream(...)))`
 * or to an in-memory chunk array for the integrity hash.
 */
export const tarHostTree = (
	spec: TarHostTreeSpec,
): Stream.Stream<Uint8Array, HostTreeTarError, never> =>
	// `Stream.unwrap` provides the channel's surrounding scope to the
	// inner Effect (see `effect/src/Channel.ts:7918` —
	// `Scope.provide(scope)`), so `Effect.addFinalizer` below binds to
	// the stream's lifecycle: the subprocess kill-on-close fires when
	// the stream terminates. The R-channel `Exclude<R, Scope>` reads
	// "scope satisfied by the stream" — not "scope dropped".
	Stream.unwrap(
		Effect.gen(function* () {
			if (spec.relPaths.length === 0) {
				return Stream.fail(
					new HostTreeTarError({
						stage: 'no-subtrees',
						operation: 'tar',
						detail: 'tarHostTree called with empty relPaths list',
					}),
				);
			}

			// Producer-boundary path defense — mirror the extraction-side
			// `isSafeArchivePath`. The caller controls `relPaths`, and they
			// are spliced straight into `tar -C <parentDir> … relPaths`. An
			// absolute path or a `..` segment would archive a subtree
			// outside `parentDir` (and on extraction escape `target`). We
			// reject at the producer rather than relying on the consumer's
			// entry validation alone.
			const unsafe = spec.relPaths.find((relPath) => !isSafeArchivePath(relPath));
			if (unsafe !== undefined) {
				return Stream.fail(
					new HostTreeTarError({
						stage: 'entry-validation',
						operation: 'tar',
						detail: `unsafe tar relPath (absolute or contains '..'): ${unsafe}`,
					}),
				);
			}

			// `-c` create, `-f -` write to stdout, `-C <dir>` cd-before,
			// `-p` preserve permissions (matches BSD-tar + GNU-tar). The
			// subprocess emits its own bytes; we don't apply any
			// transcoding.
			const args = ['-c', '-f', '-', '-C', spec.parentDir, '-p', ...spec.relPaths];
			const { child, stderrChunks } = yield* spawnTar('tar', args, ['ignore', 'pipe', 'pipe']);

			// Wrap stdout (a Node Readable) as a Stream<Uint8Array>.
			// `Stream.fromReadable` is the substrate-blessed shape.
			const stdout = child.stdout;
			if (stdout === null) {
				return Stream.fail(
					new HostTreeTarError({
						stage: 'spawn',
						operation: 'tar',
						detail: `'tar' subprocess produced no stdout pipe`,
					}),
				);
			}

			// Node `Readable` is an `AsyncIterable<Buffer>`; `Buffer`
			// extends `Uint8Array` structurally. The cast asserts the
			// nominal-vs-structural gap at the Node boundary and stays
			// off the user-facing API.
			const dataStream = Stream.fromAsyncIterable(
				stdout as unknown as AsyncIterable<Uint8Array>,
				(cause) =>
					new HostTreeTarError({
						stage: 'stream-stdout',
						operation: 'tar',
						detail: `read from tar stdout failed`,
						cause,
					}),
			);

			// After stdout closes, await the subprocess exit and surface
			// non-zero codes with the captured stderr tail. This appends
			// a "tail" sub-stream that emits zero bytes but can fail —
			// the consumer's `Stream.run` sees the exit-code failure
			// uniformly with stream-read failures.
			const exitGate: Stream.Stream<Uint8Array, HostTreeTarError, never> = Stream.fromEffect(
				Effect.promise(() => awaitProcessExit(child as ManagedProcessChild)).pipe(
					Effect.flatMap((status) =>
						status.code === 0 && status.signal === null
							? Effect.succeed(new Uint8Array(0))
							: Effect.fail(tarExitError('tar', status, stderrChunks)),
					),
				),
			).pipe(Stream.filter((bytes) => bytes.length > 0));

			return Stream.concat(dataStream, exitGate);
		}),
	);

// ---------------------------------------------------------------------------
// Untar a Stream<Uint8Array> into a target directory
// ---------------------------------------------------------------------------

export interface UntarHostTreeSpec {
	readonly target: string;
}

/**
 * Extract a tar `Stream<Uint8Array>` into `target`, preserving mode
 * bits. The target directory MUST already exist; the caller is
 * responsible (stage-and-swap creates the staging directory before
 * calling).
 *
 * The subprocess consumes from the stream and writes into `target`;
 * scope close kills the subprocess. The Effect resolves when `tar`
 * exits cleanly (code 0).
 */
export const untarHostTree = <R>(
	stream: Stream.Stream<Uint8Array, HostTreeTarError, R>,
	spec: UntarHostTreeSpec,
): Effect.Effect<void, HostTreeTarError, R | Scope.Scope> =>
	Effect.gen(function* () {
		const args = ['-x', '-f', '-', '-C', spec.target, '-p'];
		const { child, stderrChunks } = yield* spawnTar('untar', args, ['pipe', 'ignore', 'pipe']);

		const stdin = child.stdin;
		if (stdin === null) {
			return yield* Effect.fail(
				new HostTreeTarError({
					stage: 'spawn',
					operation: 'untar',
					detail: `'tar' subprocess produced no stdin pipe`,
				}),
			);
		}

		const validationState = makeTarReaderState();

		const writeChunk = (chunk: Uint8Array): Effect.Effect<void, HostTreeTarError> =>
			Effect.callback<void, HostTreeTarError>((resume) => {
				let settled = false;
				const settle = (effect: Effect.Effect<void, HostTreeTarError>): void => {
					if (!settled) {
						settled = true;
						resume(effect);
					}
				};
				const onDrain = (): void => settle(Effect.void);
				const ok = stdin.write(chunk, (cause) => {
					stdin.off('drain', onDrain);
					if (cause) {
						settle(
							Effect.fail(
								new HostTreeTarError({
									stage: 'stream-stdin',
									operation: 'untar',
									detail: `write to tar stdin failed`,
									cause,
								}),
							),
						);
					} else {
						settle(Effect.void);
					}
				});
				if (!ok) {
					stdin.once('drain', onDrain);
				}
				// Interrupt while parked on backpressure must remove the
				// drain listener so it can't resume an interrupted fiber.
				return Effect.sync(() => {
					stdin.off('drain', onDrain);
				});
			});

		// Pump the source stream into tar's stdin. Each chunk is
		// validated before it is handed to the tar subprocess, so unsafe
		// archive paths are rejected at the extraction boundary even if a
		// caller skipped any earlier preflight validation.
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.gen(function* () {
				const validationError = processTarChunk(validationState, chunk, hostTreeValidationHooks);
				if (validationError !== null) {
					return yield* Effect.fail(validationError);
				}
				yield* writeChunk(chunk);
			}),
		).pipe(
			Effect.catch((cause) =>
				cause instanceof HostTreeTarError
					? Effect.fail(cause)
					: Effect.fail(
							new HostTreeTarError({
								stage: 'stream-stdin',
								operation: 'untar',
								detail: `source stream raised before EOF`,
								cause,
							}),
						),
			),
		);

		const finalValidationError = finishTarReader(validationState, tarValidationError);
		if (finalValidationError !== null) {
			return yield* Effect.fail(finalValidationError);
		}

		// Close stdin so tar sees EOF and exits.
		yield* Effect.sync(() => stdin.end());

		// Await exit; non-zero surfaces with stderr tail.
		const status = yield* Effect.promise(() => awaitProcessExit(child as ManagedProcessChild));
		if (status.code !== 0 || status.signal !== null) {
			return yield* Effect.fail(tarExitError('untar', status, stderrChunks));
		}
	}).pipe(Effect.withSpan('substrate.host-tree-tar.untar'));
