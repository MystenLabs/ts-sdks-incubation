// Cross-process command channel — file-backed NDJSON pub/sub.
//
// Verifies the publisher/subscriber halves talk to each other through
// the on-disk files, that the protocol envelope round-trips, and that
// the tail subscription delivers records appended after the
// subscription started.

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
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

describe('command-channel', () => {
	// These tests use real wall-clock time (the file-channel tail polls
	// via `Effect.sleep`; `it.effect`'s default TestClock would freeze
	// the poll loop). `it.live` runs under the wall-clock runtime.
	it.live('publisher writes a record that the subscriber observes', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
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
			}),
		),
	);

	it.live('ack/error correlate to the originating command id', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
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
									subscriber
										.publishReply(rec.id, { kind: 'ack', detail: 'observed' })
										.pipe(Effect.catch(() => Effect.void)),
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
						const reply = yield* publisher.awaitCompletion(published, {
							timeoutMillis: 2000,
						});
						return reply;
					}),
				);
				expect(result.ok).toBe(true);
			}),
		),
	);

	it.live('awaitCompletion times out when no ack arrives', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
				const paths = commandChannelPaths(root);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const publisher = yield* makeCommandChannelPublisher(paths);
						const published = yield* publisher.publish({ tag: 'shutdown.requested' });
						return yield* publisher.awaitCompletion(published, {
							timeoutMillis: 100,
						});
					}),
				);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toMatch(/timed out/);
				}
			}),
		),
	);

	it.live('awaitCompletion correlates correctly past a large unrelated events backlog', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
				const paths = commandChannelPaths(root);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const publisher = yield* makeCommandChannelPublisher(paths);
						const subscriber = yield* makeCommandChannelSubscriber(paths, {
							fromOffset: 'start',
							pollMillis: 20,
						});

						// Seed a large backlog of unrelated engine events AND a
						// stale ack that correlates to a DIFFERENT command id.
						// `publish` snapshots the events-file offset at publish
						// time, so `awaitCompletion` tails only from there — it
						// must neither re-scan this backlog nor be fooled by the
						// stale ack into a wrong correlation.
						for (let i = 0; i < 200; i++) {
							yield* subscriber.publishEvent({
								tag: 'manifest.flushed',
								manifestVersion: i,
								at: 0,
							});
						}
						yield* subscriber.publishReply('not-the-command-we-await', {
							kind: 'ack',
							detail: 'stale',
						});

						// Supervisor acks only the command it actually observes,
						// echoing its id as the correlation key + a payload we can
						// assert against.
						yield* Effect.forkChild(
							subscriber.commands.pipe(
								Stream.runForEach((rec) =>
									subscriber
										.publishReply(rec.id, {
											kind: 'ack',
											detail: 'observed',
											payload: { echoedId: rec.id },
										})
										.pipe(Effect.catch(() => Effect.void)),
								),
								Effect.catch(() => Effect.void),
							),
							{ startImmediately: true },
						);
						yield* Effect.sleep('30 millis');

						const published = yield* publisher.publish({ tag: 'apply.requested' });
						const reply = yield* publisher.awaitCompletion(published, {
							timeoutMillis: 2000,
						});
						return { reply, publishedId: published.id, fromOffset: published.fromOffset };
					}),
				);

				// Correct reply despite the 200-event + stale-ack backlog: the
				// await correlated to THIS command's id, not the stale one.
				expect(result.reply.ok).toBe(true);
				if (result.reply.ok) {
					expect(result.reply.payload).toEqual({ echoedId: result.publishedId });
				}
				// The publish-time offset was non-zero — proving the await
				// started past the seeded backlog rather than from byte 0.
				expect(result.fromOffset).toBeGreaterThan(0);
			}),
		),
	);

	it.effect('readAllRecords replays every command on disk', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
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
			}),
		),
	);

	it.effect('engine event records carry kind: engine', () =>
		withTempRoot('cmd-channel', (root) =>
			Effect.gen(function* () {
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
			}),
		),
	);
});
