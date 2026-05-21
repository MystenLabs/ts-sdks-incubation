// Append-only NDJSON channel.
//
// One-record-per-line, atomic append via `fs.appendFileSync` with
// `flag: 'a'` (POSIX guarantees the write is atomic for buffers under
// PIPE_BUF; one JSON line is comfortably under that on every platform
// we run). The tail-reader polls via offset bookkeeping — `fs.watch`
// is unreliable across platforms for "file grew" notifications
// (especially over NFS, which the cross-process protocol must remain
// safe on per architecture § Cross-process safety protocol).
//
// Records are framed by a literal newline. A partial trailing line
// (writer mid-flight when reader observed) is buffered until the next
// poll iteration completes the line.

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

/** A line decoder. Implementations typically `Schema.decodeUnknownSync`
 *  a concrete schema; the channel I/O layer stays schema-agnostic so
 *  the substrate generic doesn't carry a `Schema.Decoder<unknown>`
 *  constraint that fights the rest of the substrate's signatures. */
export type LineDecoder<A> = (raw: unknown) => A;

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
			const parsed = yield* Effect.try({
				try: () => JSON.parse(line) as unknown,
				catch: (cause) => new CommandChannelDecodeError({ path, line, cause }),
			});
			const decoded = yield* Effect.try({
				try: () => decode(parsed),
				catch: (cause) => new CommandChannelDecodeError({ path, line, cause }),
			});
			out.push(decoded);
		}
		return out;
	});

interface TailState {
	offset: number;
	partial: string;
}

/** Read newly-appended bytes from `state.offset` to current EOF. Updates
 *  `state` in place. Returns the freshly-completed lines. A trailing
 *  partial line (no newline yet) is preserved in `state.partial` and
 *  prepended on the next poll. */
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
				readSync(fd, buf, 0, grow, state.offset);
				state.offset = stat.size;
				const chunk = state.partial + buf.toString('utf8');
				const parts = chunk.split('\n');
				state.partial = parts.pop() ?? '';
				return parts.filter((l) => l.length > 0);
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
 *  Decode errors are surfaced as Stream failures with the offending
 *  line attached so the consumer can pick a retry / skip policy.
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
	} = {},
): Stream.Stream<A, CommandChannelError, Scope.Scope> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const pollMillis = options.pollMillis ?? DEFAULT_TAIL_POLL_MILLIS;
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
			const state: TailState = { offset: initialOffset, partial: '' };
			const pollOne: Effect.Effect<ReadonlyArray<A>, CommandChannelError> = Effect.gen(
				function* () {
					const lines = yield* drainNewLines(path, state);
					if (lines.length === 0) {
						yield* Effect.sleep(`${pollMillis} millis`);
						return [] as ReadonlyArray<A>;
					}
					const decoded: A[] = [];
					for (const line of lines) {
						const parsed = yield* Effect.try({
							try: () => JSON.parse(line) as unknown,
							catch: (cause) => new CommandChannelDecodeError({ path, line, cause }),
						});
						const value = yield* Effect.try({
							try: () => decode(parsed),
							catch: (cause) => new CommandChannelDecodeError({ path, line, cause }),
						});
						decoded.push(value);
					}
					return decoded as ReadonlyArray<A>;
				},
			);
			return Stream.fromEffectRepeat(pollOne).pipe(
				Stream.flatMap((records) => Stream.fromIterable(records)),
			);
		}),
	);
