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

import { spawn } from 'node:child_process';

import { Effect, Schema, Scope, Stream } from 'effect';

import {
	awaitProcessExit,
	describeProcessExitStatus,
	type ManagedProcessChild,
	type ManagedProcessExitStatus,
} from '../process-supervisor.ts';

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

const TAR_BLOCK_SIZE = 512;
const MAX_TAR_EXTENDED_PATH_BYTES = 1024 * 1024;

const bytesToString = (bytes: Uint8Array): string => {
	const nul = bytes.indexOf(0);
	const end = nul === -1 ? bytes.length : nul;
	return Buffer.from(bytes.subarray(0, end)).toString('utf8');
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
};

const consumeBytes = (buffer: Uint8Array, count: number): Uint8Array => buffer.subarray(count);

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

const parseTarSize = (header: Uint8Array): number | null => {
	const raw = bytesToString(header.subarray(124, 136)).trim();
	if (raw === '') return 0;
	if (!/^[0-7]+$/.test(raw)) return null;
	const parsed = Number.parseInt(raw, 8);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const tarPathFromHeader = (header: Uint8Array): string => {
	const name = bytesToString(header.subarray(0, 100));
	const prefix = bytesToString(header.subarray(345, 500));
	return prefix === '' ? name : `${prefix}/${name}`;
};

const tarLinkPathFromHeader = (header: Uint8Array): string =>
	bytesToString(header.subarray(157, 257));

const trimExtendedPath = (bytes: Uint8Array): string => {
	const value = Buffer.from(bytes).toString('utf8').replace(/\n$/g, '');
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
	return value.slice(0, end);
};

const isSafeArchivePath = (entryPath: string): boolean => {
	if (
		entryPath === '' ||
		entryPath === '.' ||
		entryPath.includes('\0') ||
		entryPath.includes('\\') ||
		entryPath.startsWith('/') ||
		/^[A-Za-z]:/.test(entryPath)
	) {
		return false;
	}
	const meaningfulSegments = entryPath
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	return meaningfulSegments.length > 0 && !meaningfulSegments.includes('..');
};

const parsePaxRecords = (bytes: Uint8Array): Record<string, string> => {
	const text = Buffer.from(bytes).toString('utf8');
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < text.length) {
		const space = text.indexOf(' ', offset);
		if (space === -1) break;
		const lengthText = text.slice(offset, space);
		const recordLength = Number.parseInt(lengthText, 10);
		if (!Number.isSafeInteger(recordLength) || recordLength <= 0) break;
		const record = text.slice(space + 1, offset + recordLength).replace(/\n$/g, '');
		const eq = record.indexOf('=');
		if (eq > 0) {
			records[record.slice(0, eq)] = record.slice(eq + 1);
		}
		offset += recordLength;
	}
	return records;
};

interface TarContentState {
	readonly kind: 'pax-local' | 'pax-global' | 'gnu-path' | 'gnu-link';
	readonly size: number;
	readonly paddedSize: number;
	readonly chunks: Array<Uint8Array>;
	readonly contentBytesRead: number;
	readonly totalBytesRead: number;
}

interface TarValidationState {
	buffer: Uint8Array;
	skipRemaining: number;
	content: TarContentState | null;
	pendingPath: string | null;
	pendingLinkPath: string | null;
}

const tarValidationError = (detail: string): HostTreeTarError =>
	new HostTreeTarError({
		stage: 'entry-validation',
		operation: 'untar',
		detail,
	});

const applyExtendedContent = (
	state: TarValidationState,
	content: TarContentState,
): HostTreeTarError | null => {
	const bytes =
		content.chunks.length === 1
			? content.chunks[0]!
			: Buffer.concat(content.chunks.map((chunk) => Buffer.from(chunk)));
	if (content.kind === 'gnu-path') {
		state.pendingPath = trimExtendedPath(bytes);
		return null;
	}
	if (content.kind === 'gnu-link') {
		state.pendingLinkPath = trimExtendedPath(bytes);
		return null;
	}
	const records = parsePaxRecords(bytes);
	if (
		content.kind === 'pax-global' &&
		(records.path !== undefined || records.linkpath !== undefined)
	) {
		return tarValidationError('global pax path/linkpath records are not supported in snapshots');
	}
	if (content.kind === 'pax-local') {
		if (records.path !== undefined) state.pendingPath = records.path;
		if (records.linkpath !== undefined) state.pendingLinkPath = records.linkpath;
	}
	return null;
};

const processTarValidationChunk = (
	state: TarValidationState,
	chunk: Uint8Array,
): HostTreeTarError | null => {
	state.buffer = concatBytes(state.buffer, chunk);
	while (state.buffer.length > 0) {
		if (state.content !== null) {
			const content = state.content;
			const remaining = content.paddedSize - content.totalBytesRead;
			const take = Math.min(remaining, state.buffer.length);
			const contentTake = Math.max(0, Math.min(take, content.size - content.contentBytesRead));
			if (contentTake > 0) {
				content.chunks.push(state.buffer.subarray(0, contentTake));
			}
			state.content = {
				...content,
				contentBytesRead: content.contentBytesRead + contentTake,
				totalBytesRead: content.totalBytesRead + take,
			};
			state.buffer = consumeBytes(state.buffer, take);
			if (state.content.totalBytesRead === state.content.paddedSize) {
				const completed = state.content;
				state.content = null;
				const error = applyExtendedContent(state, completed);
				if (error !== null) return error;
			}
			continue;
		}
		if (state.skipRemaining > 0) {
			const take = Math.min(state.skipRemaining, state.buffer.length);
			state.skipRemaining -= take;
			state.buffer = consumeBytes(state.buffer, take);
			continue;
		}
		if (state.buffer.length < TAR_BLOCK_SIZE) return null;
		const header = state.buffer.subarray(0, TAR_BLOCK_SIZE);
		state.buffer = consumeBytes(state.buffer, TAR_BLOCK_SIZE);
		if (isZeroBlock(header)) continue;

		const size = parseTarSize(header);
		if (size === null) return tarValidationError('tar entry has an invalid size header');
		const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const typeflag = String.fromCharCode(header[156] ?? 0).replace('\0', '');
		if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
			if (size > MAX_TAR_EXTENDED_PATH_BYTES) {
				return tarValidationError('tar extended path record is too large');
			}
			state.content = {
				kind:
					typeflag === 'x'
						? 'pax-local'
						: typeflag === 'g'
							? 'pax-global'
							: typeflag === 'L'
								? 'gnu-path'
								: 'gnu-link',
				size,
				paddedSize,
				chunks: [],
				contentBytesRead: 0,
				totalBytesRead: 0,
			};
			continue;
		}

		const entryPath = state.pendingPath ?? tarPathFromHeader(header);
		state.pendingPath = null;
		if (!isSafeArchivePath(entryPath)) {
			return tarValidationError(`unsafe tar entry path: ${entryPath}`);
		}
		const linkPath = state.pendingLinkPath ?? tarLinkPathFromHeader(header);
		state.pendingLinkPath = null;
		if ((typeflag === '1' || typeflag === '2') && !isSafeArchivePath(linkPath)) {
			return tarValidationError(`unsafe tar link target: ${linkPath}`);
		}
		state.skipRemaining = paddedSize;
	}
	return null;
};

const finishTarValidation = (state: TarValidationState): HostTreeTarError | null => {
	if (state.content !== null) return tarValidationError('tar ended inside an extended header');
	if (state.skipRemaining !== 0) return tarValidationError('tar ended inside file content');
	if (state.buffer.length !== 0 && !isZeroBlock(state.buffer)) {
		return tarValidationError('tar ended with a partial header');
	}
	return null;
};

export const validateHostTreeTarEntries = <R>(
	stream: Stream.Stream<Uint8Array, HostTreeTarError, R>,
): Effect.Effect<void, HostTreeTarError, R> =>
	Effect.gen(function* () {
		const state: TarValidationState = {
			buffer: new Uint8Array(0),
			skipRemaining: 0,
			content: null,
			pendingPath: null,
			pendingLinkPath: null,
		};
		yield* Stream.runForEach(stream, (chunk) => {
			const error = processTarValidationChunk(state, chunk);
			return error === null ? Effect.void : Effect.fail(error);
		});
		const finalError = finishTarValidation(state);
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

			// `-c` create, `-f -` write to stdout, `-C <dir>` cd-before,
			// `-p` preserve permissions (matches BSD-tar + GNU-tar). The
			// subprocess emits its own bytes; we don't apply any
			// transcoding.
			const args = ['-c', '-f', '-', '-C', spec.parentDir, '-p', ...spec.relPaths];
			const child = yield* Effect.try({
				try: () =>
					spawn('tar', args, {
						stdio: ['ignore', 'pipe', 'pipe'],
					}),
				catch: (cause) =>
					new HostTreeTarError({
						stage: 'spawn',
						operation: 'tar',
						detail: `failed to spawn 'tar ${args.join(' ')}'`,
						cause,
					}),
			});

			// Stderr collection lives outside the data stream — we
			// accumulate the tail so an exit-code failure carries
			// actionable context. The stderr listener is removed on
			// scope close.
			const stderrChunks: Array<Uint8Array> = [];
			const onStderr = (chunk: Buffer): void => {
				stderrChunks.push(chunk);
				if (stderrChunks.length > 256) stderrChunks.splice(0, stderrChunks.length - 256);
			};
			child.stderr?.on('data', onStderr);

			// Finalise the subprocess on scope close: kill if alive,
			// drop listeners either way.
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					child.stderr?.off('data', onStderr);
					if (child.exitCode === null && child.signalCode === null) {
						child.kill('SIGKILL');
					}
				}),
			);

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
		const child = yield* Effect.try({
			try: () =>
				spawn('tar', args, {
					stdio: ['pipe', 'ignore', 'pipe'],
				}),
			catch: (cause) =>
				new HostTreeTarError({
					stage: 'spawn',
					operation: 'untar',
					detail: `failed to spawn 'tar ${args.join(' ')}'`,
					cause,
				}),
		});

		const stderrChunks: Array<Uint8Array> = [];
		const onStderr = (chunk: Buffer): void => {
			stderrChunks.push(chunk);
			if (stderrChunks.length > 256) stderrChunks.splice(0, stderrChunks.length - 256);
		};
		child.stderr?.on('data', onStderr);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				child.stderr?.off('data', onStderr);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill('SIGKILL');
				}
			}),
		);

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

		const validationState: TarValidationState = {
			buffer: new Uint8Array(0),
			skipRemaining: 0,
			content: null,
			pendingPath: null,
			pendingLinkPath: null,
		};

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
			});

		// Pump the source stream into tar's stdin. Each chunk is
		// validated before it is handed to the tar subprocess, so unsafe
		// archive paths are rejected at the extraction boundary even if a
		// caller skipped any earlier preflight validation.
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.gen(function* () {
				const validationError = processTarValidationChunk(validationState, chunk);
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

		const finalValidationError = finishTarValidation(validationState);
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
