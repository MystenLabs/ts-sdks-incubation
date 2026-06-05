// Cross-process command-channel IPC bridge for `devstack up`.
//
// Relocated out of `up.ts` (pure relocation, no behavior change) so the
// `up` verb's boot bundle (`buildUpBootBundle`) reads in roughly one screen.
// This module owns the supervisor side of the file-backed command channel:
// it tails the on-disk command log, dispatches each decoded `EngineCommand`
// onto the live supervisor (`handle.runCommand`), and acks/fails the
// originating record — with deferred ack/fail for the async `snapshot.capture`
// path (correlated by snapshot id through the engine event stream).
//
// `up.ts`'s `beforeInitialAcquire` hook installs this once, then tees every
// engine event through the returned `publishEvent` so peer subscribers see
// it AND any pending snapshot-capture ack lands after its engine event.

import { Cause, Effect, Ref, type Scope, Stream } from 'effect';

import type { EngineCommand, EngineEvent } from '../../substrate/events.ts';
import {
	commandChannelPaths,
	makeCommandChannelSubscriber,
	type SupervisorHandle,
} from '../../substrate/runtime/index.ts';

import { isEngineCommand } from './engine-command.ts';

/** Captured snapshot metadata is round-tripped through the
 *  command-channel ack payload so the publisher's `awaitCompletion`
 *  can surface it without tailing the engine event stream. */
interface SnapshotCaptureAckPayload {
	readonly kind: 'captured' | 'failed' | 'skipped';
	readonly snapshotId?: string;
	readonly name?: string;
	readonly summary?: string;
	readonly reason?: string;
}

interface PendingSnapshotCapture {
	readonly commandId: string;
	readonly snapshotId: string;
	readonly name?: string;
}

/** Detect snapshot-capture completion events on the published stream
 *  so we can ack/fail the originating `snapshot.capture` command with
 *  a structured payload (snapshot metadata on success; failure summary
 *  on failure). The `summary` is surfaced through `awaitCompletion`'s
 *  reply.payload. */
const snapshotCaptureAckFromEvent = (
	event: unknown,
): { readonly snapshotId: string; readonly payload: SnapshotCaptureAckPayload } | null => {
	if (typeof event !== 'object' || event === null) return null;
	const record = event as {
		readonly tag?: string;
		readonly snapshotId?: string;
		readonly name?: string;
		readonly summary?: string;
		readonly reason?: string;
	};
	if (typeof record.snapshotId !== 'string') return null;
	if (record.tag === 'snapshot.captured') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'captured',
				snapshotId: record.snapshotId,
				...(record.name === undefined ? {} : { name: record.name }),
			},
		};
	}
	if (record.tag === 'snapshot.captureFailed') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'failed',
				snapshotId: record.snapshotId,
				...(record.name === undefined ? {} : { name: record.name }),
				...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
			},
		};
	}
	if (record.tag === 'snapshot.captureSkipped') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'skipped',
				snapshotId: record.snapshotId,
				...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
			},
		};
	}
	return null;
};

/**
 * Install the supervisor side of the file-backed command channel. Tails the
 * on-disk command log, dispatches each decoded command onto `params.handle`,
 * and acks/fails the record. Returns a `publishEvent` the caller tees every
 * engine event through so peer subscribers see it and pending capture acks
 * resolve after their engine event.
 */
export const installCommandChannelBridge = (params: {
	readonly stackRoot: string;
	readonly handle: SupervisorHandle;
}): Effect.Effect<
	{
		readonly publishEvent: (event: EngineEvent) => Effect.Effect<void>;
	},
	unknown,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(params.stackRoot), {
			fromOffset: 'current',
		});

		// snapshotId → pending command record id. Populated when the
		// bridge dispatches a `snapshot.capture` command; drained when
		// the matching completion event flows through `publishEvent`.
		const pendingCaptures = yield* Ref.make<ReadonlyMap<string, PendingSnapshotCapture>>(new Map());

		// Drive the command stream so a stream-LEVEL failure does not
		// permanently wedge cross-process IPC. The subscriber's `commands`
		// tail decodes with the `onDecodeError: 'fail'` default, so ONE
		// malformed/truncated NDJSON line (CLI killed mid-append, partial
		// disk write) raises `CommandChannelError` and terminates the
		// stream. If `runForEach` were the only consumer, the live
		// supervisor would then process NO further commands for the rest of
		// the `up` session (a sibling `snapshot save`/`apply`/`prune`
		// appends but is never read, and its `awaitCompletion` times out
		// with no diagnostic). Instead we log the failure and RE-SUBSCRIBE:
		// `subscriber.commands` is `tailRecords(... fromOffset: 'current')`,
		// and each subscription re-runs its builder, re-anchoring the tail
		// at the file's current EOF — so the corrupt line (and any records
		// that were buffered alongside it) are skipped and subsequent
		// commands are processed again. A short delay before resume avoids a
		// busy spin if the tail keeps failing. The publisher's reply-tail
		// already uses `onDecodeError: 'skip'` for the same NDJSON-tolerance
		// reason; this gives the command-subscriber side equivalent
		// resilience without touching the shared subscriber.
		const consumeCommands: Effect.Effect<void, never, Scope.Scope> = subscriber.commands
			.pipe(
				Stream.runForEach((record) =>
					Effect.gen(function* () {
						if (!isEngineCommand(record.command)) {
							yield* subscriber
								.publishReply(record.id, {
									kind: 'error',
									message: 'invalid command',
									detail: 'command payload did not match EngineCommand',
								})
								.pipe(Effect.catch(() => Effect.void));
							return;
						}
						const cmd: EngineCommand = record.command;
						// Snapshot capture is a background task in the supervisor:
						// `runCommand` returns as soon as the fork is scheduled, so
						// auto-acking here would race the actual capture. We defer
						// ack/fail until the matching `snapshot.captured` /
						// `snapshot.captureFailed` / `snapshot.captureSkipped` event
						// flows through `publishEvent` below.
						if (cmd.tag === 'snapshot.capture') {
							if (cmd.snapshotId === undefined) {
								// Without a snapshotId we cannot correlate the completion
								// event back to this command record. Fall through to the
								// plain auto-ack path — the CLI side mints an id, so
								// this branch is defensive.
								yield* params.handle.runCommand(cmd).pipe(
									Effect.andThen(subscriber.publishReply(record.id, { kind: 'ack' })),
									Effect.catchCause((cause) =>
										subscriber
											.publishReply(record.id, {
												kind: 'error',
												message: 'command failed',
												detail: Cause.pretty(cause as Cause.Cause<unknown>),
											})
											.pipe(Effect.catch(() => Effect.void)),
									),
								);
								return;
							}
							yield* Ref.update(pendingCaptures, (map) => {
								const next = new Map(map);
								next.set(cmd.snapshotId!, {
									commandId: record.id,
									snapshotId: cmd.snapshotId!,
									...(cmd.name === undefined ? {} : { name: cmd.name }),
								});
								return next;
							});
							yield* params.handle.runCommand(cmd).pipe(
								Effect.catchCause((cause) =>
									Effect.gen(function* () {
										// Synchronous dispatch failure (e.g. command-loop refused).
										// Drain the pending entry and surface the failure now.
										yield* Ref.update(pendingCaptures, (map) => {
											const next = new Map(map);
											next.delete(cmd.snapshotId!);
											return next;
										});
										yield* subscriber
											.publishReply(record.id, {
												kind: 'error',
												message: 'command failed',
												detail: Cause.pretty(cause as Cause.Cause<unknown>),
											})
											.pipe(Effect.catch(() => Effect.void));
									}),
								),
							);
							return;
						}
						yield* params.handle.runCommand(cmd).pipe(
							Effect.andThen(subscriber.publishReply(record.id, { kind: 'ack' })),
							Effect.catchCause((cause) =>
								subscriber
									.publishReply(record.id, {
										kind: 'error',
										message: 'command failed',
										detail: Cause.pretty(cause as Cause.Cause<unknown>),
									})
									.pipe(Effect.catch(() => Effect.void)),
							),
						);
					}),
				),
			)
			.pipe(
				Effect.catchCause((cause): Effect.Effect<void, never, Scope.Scope> => {
					// Scope-close interrupts this forked fiber via an interrupt
					// cause. Re-raise it so the fork stops cleanly on `up`
					// teardown — resuming here would leak the fiber and spam
					// stderr forever.
					if (Cause.hasInterrupts(cause as Cause.Cause<unknown>)) {
						return Effect.failCause(cause as Cause.Cause<never>);
					}
					// Otherwise a stream-level failure (e.g. a corrupt NDJSON
					// line tripping the subscriber's `onDecodeError: 'fail'`
					// default). Log it, pause briefly to avoid a busy spin, then
					// re-subscribe by recursing — a fresh tail re-anchors at the
					// file's current EOF, so the next command is processed
					// instead of IPC wedging for the session.
					return Effect.sync(() => {
						process.stderr.write(
							`command channel decode failed; resuming tail: ${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
					}).pipe(
						Effect.andThen(Effect.sleep('200 millis')),
						Effect.andThen(Effect.suspend(() => consumeCommands)),
					);
				}),
			);

		yield* Effect.forkScoped(consumeCommands);

		const publishEvent = (event: EngineEvent): Effect.Effect<void> =>
			Effect.gen(function* () {
				// First, route the event to the events file so peer
				// subscribers see it. THEN drain any matching pending
				// capture so the ack lands after the engine event — this
				// preserves the "captured before ack" ordering tests rely
				// on (test/cli/main.test.ts:483-491 publishes captured then
				// acks; we mirror that ordering from the supervisor side).
				yield* subscriber.publishEvent(event).pipe(Effect.catch(() => Effect.void));
				const ackFromEvent = snapshotCaptureAckFromEvent(event);
				if (ackFromEvent === null) return;
				const pending = yield* Ref.modify(pendingCaptures, (map) => {
					const entry = map.get(ackFromEvent.snapshotId);
					if (entry === undefined) return [null, map];
					const next = new Map(map);
					next.delete(ackFromEvent.snapshotId);
					return [entry, next];
				});
				if (pending === null) return;
				if (ackFromEvent.payload.kind === 'captured') {
					yield* subscriber
						.publishReply(pending.commandId, {
							kind: 'ack',
							detail: 'captured',
							payload: ackFromEvent.payload,
						})
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				if (ackFromEvent.payload.kind === 'failed') {
					yield* subscriber
						.publishReply(pending.commandId, {
							kind: 'error',
							message: 'snapshot capture failed',
							detail: ackFromEvent.payload.summary,
							payload: ackFromEvent.payload,
						})
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				// skipped
				yield* subscriber
					.publishReply(pending.commandId, {
						kind: 'error',
						message: 'snapshot capture skipped',
						detail: ackFromEvent.payload.reason,
						payload: ackFromEvent.payload,
					})
					.pipe(Effect.catch(() => Effect.void));
			});

		return { publishEvent };
	});
