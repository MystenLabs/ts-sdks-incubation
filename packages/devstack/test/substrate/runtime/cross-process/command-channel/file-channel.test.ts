// Primitive-level contract for `tailRecords` decode-error policy.
//
// The CLI-surface test at `test/cli/event-stream-decoder.test.ts` pins
// the end-to-end "CLI survives a truncated events.ndjson row" flow, but
// the underlying `onDecodeError: 'skip' | 'fail'` switch on
// `tailRecords` itself has no direct coverage. This file pins the
// primitive's contract independently so a refactor that breaks the
// skip / fail / atomic-append-race semantics is caught here, not three
// layers up in the snapshot-completion fiber.
//
// STYLE_GUIDE §20 mandates the skip policy for NDJSON readers that race
// atomic-append writers. These tests use `it.live` (not `it.effect`)
// because the tail-poll loop uses `Effect.sleep`; `it.effect`'s default
// TestClock would freeze the poll loop. Matches the convention already
// established by `test/substrate/runtime/cross-process/command-channel.test.ts`.

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Cause, Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	CommandChannelDecodeError,
	tailRecords,
} from '../../../../../src/substrate/runtime/cross-process/command-channel/file-channel.ts';
import { withTempRoot } from '../../../../helpers/with-temp-root.ts';

interface TestRecord {
	readonly a: number;
}

// A minimal decoder that mirrors how `tailRecords` is actually called in
// production: the file-channel layer is schema-agnostic, the decoder is
// the caller's responsibility. Throw on shape mismatch so the channel
// layer wraps the throw in `CommandChannelDecodeError`.
const decodeRecord = (raw: unknown): TestRecord => {
	if (raw === null || typeof raw !== 'object' || !('a' in raw) || typeof raw.a !== 'number') {
		throw new Error(`bad record: ${JSON.stringify(raw)}`);
	}
	return { a: raw.a };
};

describe('tailRecords decode-error policy', () => {
	it.live('onDecodeError:skip drops invalid JSON lines and emits the valid records', () =>
		withTempRoot('file-channel-tail', (root) =>
			Effect.gen(function* () {
				const file = join(root, 'events.ndjson');
				// Two valid lines bracketing one malformed (un-parseable JSON) line.
				writeFileSync(file, '{"a":1}\n{not json\n{"a":2}\n');
				const collected = yield* Effect.scoped(
					tailRecords<TestRecord>(file, decodeRecord, {
						fromOffset: 'start',
						pollMillis: 10,
						onDecodeError: 'skip',
					}).pipe(Stream.take(2), Stream.runCollect),
				);
				expect(Array.from(collected)).toEqual([{ a: 1 }, { a: 2 }]);
			}),
		),
	);

	it.live('default (onDecodeError:fail) surfaces a CommandChannelDecodeError', () =>
		withTempRoot('file-channel-tail', (root) =>
			Effect.gen(function* () {
				const file = join(root, 'events.ndjson');
				writeFileSync(file, '{"a":1}\n{not json\n{"a":2}\n');
				const exit = yield* Effect.scoped(
					tailRecords<TestRecord>(file, decodeRecord, {
						fromOffset: 'start',
						pollMillis: 10,
					}).pipe(Stream.runCollect),
				).pipe(Effect.exit);
				expect(exit._tag).toBe('Failure');
				if (exit._tag === 'Failure') {
					const failures = exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error);
					expect(failures.length).toBeGreaterThan(0);
					expect(failures[0]).toBeInstanceOf(CommandChannelDecodeError);
				}
			}),
		),
	);

	// Regression for Phase B1: `drainNewLines` advances `state.offset` by
	// the actual number of bytes returned by `readSync(2)`, not by
	// `stat.size - state.offset`. A short read (NFS, exotic FS) used to
	// silently lose `(grow - bytesRead)` bytes on the next poll.
	//
	// We can't force POSIX `read(2)` to short-return from userland, but we
	// CAN verify the visible contract the fix protects: with many small
	// appended records arriving across multiple poll cycles, the tail
	// emits every record without dropping bytes. With the regressed
	// `state.offset = stat.size` write, even one short read would drop a
	// chunk and the test would fail.
	it.live('multi-cycle tail emits every appended record without losing bytes', () =>
		withTempRoot('file-channel-tail', (root) =>
			Effect.gen(function* () {
				const file = join(root, 'events.ndjson');
				writeFileSync(file, '');
				const records = Array.from({ length: 25 }, (_, i) => ({ a: i + 1 }));
				const collected = yield* Effect.scoped(
					Effect.gen(function* () {
						const fiber = yield* Effect.forkChild(
							tailRecords<TestRecord>(file, decodeRecord, {
								fromOffset: 'start',
								pollMillis: 5,
							}).pipe(Stream.take(records.length), Stream.runCollect),
							{ startImmediately: true },
						);
						// Drip the records across multiple poll cycles. Each
						// append surfaces in a separate poll iteration, so the
						// short-read invariant is exercised once per record.
						for (const record of records) {
							yield* Effect.sleep('15 millis');
							yield* Effect.sync(() => {
								appendFileSync(file, `${JSON.stringify(record)}\n`);
							});
						}
						return yield* Fiber.await(fiber);
					}),
				);
				expect(collected._tag).toBe('Success');
				if (collected._tag === 'Success') {
					expect(Array.from(collected.value)).toEqual(records);
				}
			}),
		),
	);

	it.live('onDecodeError:skip survives an atomic-append race (mid-write truncated line)', () =>
		withTempRoot('file-channel-tail', (root) =>
			Effect.gen(function* () {
				const file = join(root, 'events.ndjson');
				// Writer is partway through atomic-appending `{"a":2}\n` — the
				// reader observes only `{"a":2` (no newline, malformed JSON).
				// `tailRecords` buffers no-newline tails in `state.partial`, so
				// the actual hazard the 'skip' policy protects against is a
				// COMPLETED malformed line (newline-terminated garbage) such
				// as a peer crashing mid-record. Reproduce that here: a
				// completed-but-corrupt line between two healthy records.
				writeFileSync(file, '{"a":1}\n{"a":2\n');
				const collected = yield* Effect.scoped(
					Effect.gen(function* () {
						const fiber = yield* Effect.forkChild(
							tailRecords<TestRecord>(file, decodeRecord, {
								fromOffset: 'start',
								pollMillis: 10,
								onDecodeError: 'skip',
							}).pipe(Stream.take(2), Stream.runCollect),
							{ startImmediately: true },
						);
						// Give the tail a chance to attach and drain the seed.
						yield* Effect.sleep('40 millis');
						// Writer completes its next atomic append.
						yield* Effect.sync(() => {
							appendFileSync(file, '{"a":3}\n');
						});
						return yield* Fiber.await(fiber);
					}),
				);
				expect(collected._tag).toBe('Success');
				if (collected._tag === 'Success') {
					expect(Array.from(collected.value)).toEqual([{ a: 1 }, { a: 3 }]);
				}
			}),
		),
	);
});
