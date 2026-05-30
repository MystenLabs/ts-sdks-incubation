// Append-only NDJSON channel.
//
// One-record-per-line. Each append is `fs.appendFileSync` with
// `flag: 'a'`, serialized cross-process by the runtime-control lock
// (`withRuntimeControlLock`, an O_EXCL create/unlink). The LOCK — not
// PIPE_BUF — is what guarantees a record never interleaves with a
// concurrent append: a JSON record can exceed PIPE_BUF (the POSIX
// atomic-append bound is only ~512 bytes on macOS, 4096 on Linux), so
// relying on PIPE_BUF alone would let a large record tear under
// contention. The tail-reader polls via offset bookkeeping — `fs.watch`
// is unreliable across platforms for "file grew" notifications
// (especially over NFS, which the cross-process protocol must remain
// safe on per architecture § Cross-process safety protocol).
//
// Records are framed by a literal newline. A partial trailing line
// (writer mid-flight when reader observed, or a short read bisecting a
// record) is buffered as raw bytes until a later poll completes the
// line — see `drainNewLines` for why the buffer is bytes, not a string.

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { Data, Effect, Scope, Stream } from 'effect';

import { parseJsonText } from '../../runtime-decode.ts';
import { acquireStackLock } from '../stack-lock.ts';
import { runtimeControlLockPathForChannelFile } from './runtime-control-lock.ts';

/** Tagged failure for any I/O error during append. */
export class CommandChannelIoError extends Data.TaggedError('CommandChannelIoError')<{
	readonly path: string;
	readonly stage: 'append' | 'open' | 'read' | 'stat' | 'init';
	readonly cause: unknown;
}> {}

/** Tagged failure when a tailed line cannot be decoded against the
 *  record schema. The malformed line is preserved so consumers can
 *  surface it for debugging without spamming retries. */
export class CommandChannelDecodeError extends Data.TaggedError('CommandChannelDecodeError')<{
	readonly path: string;
	readonly line: string;
	readonly cause: unknown;
}> {}

export type CommandChannelError = CommandChannelIoError | CommandChannelDecodeError;

/** Default tail poll interval. Chosen to be small enough for
 *  interactive CLI responsiveness (a `down` ack returns within ~50ms)
 *  while staying out of the way of process schedulers. */
export const DEFAULT_TAIL_POLL_MILLIS = 50;

const withRuntimeControlLock = <A>(
	path: string,
	stage: CommandChannelIoError['stage'],
	effect: Effect.Effect<A, CommandChannelIoError>,
): Effect.Effect<A, CommandChannelIoError> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* acquireStackLock(runtimeControlLockPathForChannelFile(path)).pipe(
				Effect.mapError((cause) => new CommandChannelIoError({ path, stage, cause })),
			);
			return yield* effect;
		}),
	);

/** Ensure the file exists. Idempotent. Creates parent dir if needed. */
export const ensureFile = (path: string): Effect.Effect<void, CommandChannelIoError> =>
	withRuntimeControlLock(
		path,
		'init',
		Effect.try({
			try: () => {
				mkdirSync(dirname(path), { recursive: true });
				if (!existsSync(path)) {
					writeFileSync(path, '', { flag: 'a' });
				}
			},
			catch: (cause) => new CommandChannelIoError({ path, stage: 'init', cause }),
		}),
	);

/** Append one record as a single NDJSON line. The trailing newline
 *  ensures the next writer's append starts a fresh record. */
export const appendRecord = (
	path: string,
	record: unknown,
): Effect.Effect<void, CommandChannelIoError> =>
	withRuntimeControlLock(
		path,
		'append',
		Effect.try({
			try: () => {
				mkdirSync(dirname(path), { recursive: true });
				appendFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'a' });
			},
			catch: (cause) => new CommandChannelIoError({ path, stage: 'append', cause }),
		}),
	);

/** A line decoder. The channel I/O layer stays schema-agnostic so
 *  callers can pick their own wire schema without this generic
 *  carrying a `Schema.Decoder<unknown>` constraint. */
export type LineDecoder<A> = (raw: unknown) => A;

const decodeLine = <A>(
	path: string,
	line: string,
	decode: LineDecoder<A>,
): Effect.Effect<A, CommandChannelDecodeError> =>
	parseJsonText(line, {
		source: path,
		mkError: (issue) => new CommandChannelDecodeError({ path, line, cause: issue.cause ?? issue }),
	}).pipe(
		Effect.flatMap((parsed) =>
			Effect.try({
				try: () => decode(parsed),
				catch: (cause) => new CommandChannelDecodeError({ path, line, cause }),
			}),
		),
	);

/** Read the entire current contents into structured records. Useful at
 *  startup to backfill state, and as a test seam. */
export const readAllRecords = <A>(
	path: string,
	decode: LineDecoder<A>,
): Effect.Effect<ReadonlyArray<A>, CommandChannelError> =>
	Effect.gen(function* () {
		if (!existsSync(path)) return [];
		const raw = yield* Effect.try({
			try: () => {
				const fd = openSync(path, 'r');
				try {
					const { size } = statSync(path);
					const buf = Buffer.alloc(size);
					readSync(fd, buf, 0, size, 0);
					return buf.toString('utf8');
				} finally {
					closeSync(fd);
				}
			},
			catch: (cause) => new CommandChannelIoError({ path, stage: 'read', cause }),
		});
		const lines = raw.split('\n').filter((l) => l.length > 0);
		const out: A[] = [];
		for (const line of lines) {
			out.push(yield* decodeLine(path, line, decode));
		}
		return out;
	});

interface TailState {
	offset: number;
	/** Raw, not-yet-decoded bytes of the trailing partial line. Held as a
	 *  Buffer rather than a decoded string so an incomplete UTF-8
	 *  multibyte sequence straddling a short-read boundary survives intact
	 *  until its continuation bytes arrive on the next poll. Decoding
	 *  per-read (the old behaviour) emitted U+FFFD for the split sequence
	 *  and lost the continuation bytes, which could corrupt a non-ASCII
	 *  record into invalid JSON that is then silently dropped. */
	partial: Buffer;
}

/** Read newly-appended bytes from `state.offset` to current EOF. Updates
 *  `state` in place. Returns the freshly-completed lines. A trailing
 *  partial line (no newline yet) is preserved as raw bytes in
 *  `state.partial` and prepended on the next poll. */
const drainNewLines = (
	path: string,
	state: TailState,
): Effect.Effect<ReadonlyArray<string>, CommandChannelIoError> =>
	Effect.try({
		try: () => {
			if (!existsSync(path)) return [];
			const stat = statSync(path);
			if (stat.size <= state.offset) return [];
			const grow = stat.size - state.offset;
			const fd = openSync(path, 'r');
			try {
				const buf = Buffer.alloc(grow);
				// POSIX `read(2)` may short-return (especially across
				// filesystems like NFS); advance the offset by what was
				// ACTUALLY read, not what we asked for. A short read just
				// means the rest will arrive on the next poll iteration.
				const bytesRead = readSync(fd, buf, 0, grow, state.offset);
				if (bytesRead <= 0) return [];
				state.offset += bytesRead;
				// Split on the newline BYTE (0x0A) and decode only complete
				// lines. A short read can bisect a multibyte codepoint; by
				// keeping the trailing fragment as raw bytes we never decode
				// a half codepoint, so non-ASCII records reassemble byte-for-
				// byte across poll cycles. 0x0A never appears as a
				// continuation byte in UTF-8, so byte-level framing is sound.
				const chunk = Buffer.concat([state.partial, buf.subarray(0, bytesRead)]);
				const completedLines: string[] = [];
				let lineStart = 0;
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] === 0x0a) {
						if (i > lineStart) {
							completedLines.push(chunk.toString('utf8', lineStart, i));
						}
						lineStart = i + 1;
					}
				}
				// Retain the unterminated remainder (possibly an incomplete
				// multibyte sequence) as raw bytes for the next poll.
				state.partial = Buffer.from(chunk.subarray(lineStart));
				return completedLines;
			} finally {
				closeSync(fd);
			}
		},
		catch: (cause) => new CommandChannelIoError({ path, stage: 'read', cause }),
	});

/** Tail a file as a Stream of decoded records. The Stream is bound to
 *  the surrounding Scope: when the Scope closes, polling stops.
 *
 *  - `fromOffset === 'current'` skips existing content; starts at EOF.
 *  - `fromOffset === 'start'` replays every existing record then tails.
 *  - `fromOffset === number` resumes from a known byte offset.
 *
 *  By default decode errors are surfaced as Stream failures with the
 *  offending line attached so the consumer can pick a retry / skip
 *  policy. Pass `onDecodeError: 'skip'` to drop the bad line instead —
 *  required for NDJSON readers that race atomic-append writers (a
 *  truncated/corrupt mid-flight line is normal and MUST NOT kill the
 *  stream; see STYLE_GUIDE §20).
 *
 *  The poll loop uses `Effect.sleep` between iterations, so cooperative
 *  scheduling is preserved (no busy loop).
 */
export const tailRecords = <A>(
	path: string,
	decode: LineDecoder<A>,
	options: {
		readonly fromOffset?: 'start' | 'current' | number;
		readonly pollMillis?: number;
		readonly onDecodeError?: 'fail' | 'skip';
	} = {},
): Stream.Stream<A, CommandChannelError, Scope.Scope> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const pollMillis = options.pollMillis ?? DEFAULT_TAIL_POLL_MILLIS;
			const onDecodeError = options.onDecodeError ?? 'fail';
			yield* ensureFile(path);
			const initialOffset = yield* Effect.try({
				try: () => {
					if (options.fromOffset === 'start' || options.fromOffset === undefined) {
						return 0;
					}
					if (options.fromOffset === 'current') {
						return existsSync(path) ? statSync(path).size : 0;
					}
					return options.fromOffset;
				},
				catch: (cause) => new CommandChannelIoError({ path, stage: 'stat', cause }),
			});
			const state: TailState = { offset: initialOffset, partial: Buffer.alloc(0) };
			const pollOne: Effect.Effect<ReadonlyArray<A>, CommandChannelError> = Effect.gen(
				function* () {
					const lines = yield* drainNewLines(path, state);
					if (lines.length === 0) {
						yield* Effect.sleep(`${pollMillis} millis`);
						return [] as ReadonlyArray<A>;
					}
					const decoded: A[] = [];
					for (const line of lines) {
						if (onDecodeError === 'skip') {
							const result = yield* decodeLine(path, line, decode).pipe(
								Effect.tapError((cause) =>
									Effect.logDebug(`tail-records: skipped malformed line at ${path}`).pipe(
										Effect.annotateLogs({ line: cause.line, cause: String(cause.cause) }),
									),
								),
								Effect.option,
							);
							if (result._tag === 'Some') {
								decoded.push(result.value);
							}
						} else {
							decoded.push(yield* decodeLine(path, line, decode));
						}
					}
					return decoded as ReadonlyArray<A>;
				},
			);
			return Stream.fromEffectRepeat(pollOne).pipe(
				Stream.flatMap((records) => Stream.fromIterable(records)),
			);
		}),
	);
