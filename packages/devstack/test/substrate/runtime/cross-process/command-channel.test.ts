// Cross-process command channel — file-backed NDJSON pub/sub.
//
// Verifies the publisher/subscriber halves talk to each other through
// the on-disk files, that the protocol envelope round-trips, and that
// the tail subscription delivers records appended after the
// subscription started.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Fiber, Schema, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type { EngineCommand } from '../../../../src/substrate/events.ts';
import {
	commandChannelPaths,
	CommandRecordSchema,
	EventRecordSchema,
	makeCommandChannelPublisher,
	makeCommandChannelSubscriber,
	readAllRecords,
	type CommandRecord,
	type EventRecord,
} from '../../../../src/substrate/runtime/cross-process/command-channel/index.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'cmd-channel-'));

describe('command-channel', () => {
	// These tests use real wall-clock time (the file-channel tail polls
	// via `Effect.sleep`; `it.effect`'s default TestClock would freeze
	// the poll loop). `it.live` runs under the wall-clock runtime.
	it.live('publisher writes a record that the subscriber observes', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const paths = commandChannelPaths(root);
				const sub = yield* Effect.scoped(
					Effect.gen(function* () {
						const subscriber = yield* makeCommandChannelSubscriber(paths, {
							fromOffset: 'start',
							pollMillis: 20,
						});
						const publisher = yield* makeCommandChannelPublisher(paths);
						const collected: CommandRecord[] = [];
						const fiber = yield* Effect.forkChild(
							subscriber.commands.pipe(
								Stream.take(1),
								Stream.runForEach((rec) =>
									Effect.sync(() => {
										collected.push(rec);
									}),
								),
								Effect.catch(() => Effect.void),
							),
							{ startImmediately: true },
						);
						// Give the tail a chance to attach before we append.
						yield* Effect.sleep('30 millis');
						yield* publisher.publish({ tag: 'shutdown.requested' });
						// Drain the fiber.
						yield* Fiber.await(fiber);
						return collected;
					}),
				);
				expect(sub).toHaveLength(1);
				const cmd = sub[0]!.command as { tag: string };
				expect(cmd.tag).toBe('shutdown.requested');
				expect(sub[0]!.publisherPid).toBe(process.pid);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.live('ack/error correlate to the originating command id', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const paths = commandChannelPaths(root);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const publisher = yield* makeCommandChannelPublisher(paths);
						const subscriber = yield* makeCommandChannelSubscriber(paths, {
							fromOffset: 'start',
							pollMillis: 20,
						});
						// Fork a "supervisor" that acks anything it sees.
						yield* Effect.forkChild(
							subscriber.commands.pipe(
								Stream.runForEach((rec) =>
									subscriber.ack(rec.id, 'observed').pipe(Effect.catch(() => Effect.void)),
								),
								Effect.catch(() => Effect.void),
							),
							{ startImmediately: true },
						);
						// Give the supervisor a tick to attach.
						yield* Effect.sleep('30 millis');
						const command = {
							tag: 'shutdown.hardKillRequested',
							signal: 'SIGINT',
							exitCode: 130,
							at: 0,
						} satisfies EngineCommand;
						const published = yield* publisher.publish(command);
						const reply = yield* publisher.awaitCompletion(published.id, {
							timeoutMillis: 2000,
						});
						return reply;
					}),
				);
				expect(result.ok).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.live('awaitCompletion times out when no ack arrives', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const paths = commandChannelPaths(root);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const publisher = yield* makeCommandChannelPublisher(paths);
						const published = yield* publisher.publish({ tag: 'shutdown.requested' });
						return yield* publisher.awaitCompletion(published.id, {
							timeoutMillis: 100,
						});
					}),
				);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toMatch(/timed out/);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('readAllRecords replays every command on disk', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const paths = commandChannelPaths(root);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publisher = yield* makeCommandChannelPublisher(paths);
						yield* publisher.publish({ tag: 'shutdown.requested' });
						yield* publisher.publish({
							tag: 'shutdown.hardKillRequested',
							signal: 'SIGTERM',
							exitCode: 143,
							at: 0,
						});
						yield* publisher.publish({ tag: 'apply.requested' });
					}),
				);
				const decode = Schema.decodeUnknownSync(CommandRecordSchema);
				const all = yield* readAllRecords<CommandRecord>(paths.commandsFile, (raw) => decode(raw));
				expect(all).toHaveLength(3);
				expect((all[0]!.command as { tag: string }).tag).toBe('shutdown.requested');
				expect((all[1]!.command as { tag: string }).tag).toBe('shutdown.hardKillRequested');
				expect((all[2]!.command as { tag: string }).tag).toBe('apply.requested');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('engine event records carry kind: engine', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const paths = commandChannelPaths(root);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const subscriber = yield* makeCommandChannelSubscriber(paths);
						yield* subscriber.publishEvent({ tag: 'manifest.flushed', manifestVersion: 7, at: 0 });
					}),
				);
				const decode = Schema.decodeUnknownSync(EventRecordSchema);
				const all = yield* readAllRecords<EventRecord>(paths.eventsFile, (raw) => decode(raw));
				expect(all).toHaveLength(1);
				expect(all[0]!.kind).toBe('engine');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
