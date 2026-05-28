// High-level cross-process command channel.
//
// Two halves built on the same `commands.ndjson` + `events.ndjson` pair:
//
//   - Publisher side (CLI / TUI / programmable API caller): appends to
//     `commands.ndjson`; tails `events.ndjson` so it can correlate
//     ack/error replies AND surface incoming engine events (for `logs`
//     and `status --watch`-style verbs).
//
//   - Supervisor side: tails `commands.ndjson` to receive incoming
//     intents; appends to `events.ndjson` to broadcast engine events
//     and ack/error replies.
//
// Both halves are scope-bound — the underlying poll fiber is forked
// into the surrounding Scope and stops when the Scope closes.

import { hostname as nodeHostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { Effect, Option, Ref, Stream, Scope } from 'effect';

import type { EngineCommand } from '../../../events.ts';
import { decodeUnknownSync } from '../../runtime-decode.ts';
import { selfPid } from '../self-pid.ts';
import { type CommandChannelError, appendRecord, ensureFile, tailRecords } from './file-channel.ts';
import {
	COMMAND_CHANNEL_PROTOCOL_VERSION,
	CommandRecordSchema,
	EventRecordSchema,
	type CommandRecord,
	type EventRecord,
} from './protocol.ts';

export interface CommandChannelPaths {
	readonly commandsFile: string;
	readonly eventsFile: string;
}

export const COMMAND_CHANNEL_COMMANDS_FILE_NAME = 'commands.ndjson';
export const COMMAND_CHANNEL_EVENTS_FILE_NAME = 'events.ndjson';

/** Build a `command-channel` paths bundle from a stackRoot dir. The
 *  files live next to the existing cross-process artifacts. */
export const commandChannelPaths = (stackRoot: string): CommandChannelPaths => ({
	commandsFile: `${stackRoot}/${COMMAND_CHANNEL_COMMANDS_FILE_NAME}`,
	eventsFile: `${stackRoot}/${COMMAND_CHANNEL_EVENTS_FILE_NAME}`,
});

// -----------------------------------------------------------------------------
// Publisher side
// -----------------------------------------------------------------------------

export interface PublishedCommand {
	/** Per-record id used to correlate `ack` / `error` replies. */
	readonly id: string;
}

/**
 * Publisher half: append a typed command, optionally await its
 * corresponding ack/error reply.
 *
 * `publish(cmd)` writes one record and returns the id; the caller can
 * then `awaitCompletion(id)` to block until the supervisor either acks
 * or errors. `awaitCompletion` is a separate seam so verbs that don't
 * need correlation (TUI-style fire-and-forget) skip the wait.
 */
export interface CommandChannelPublisher {
	readonly publish: (
		command: EngineCommand,
	) => Effect.Effect<PublishedCommand, CommandChannelError>;
	readonly awaitCompletion: (
		id: string,
		options?: { readonly timeoutMillis?: number },
	) => Effect.Effect<
		| { readonly ok: true; readonly payload?: unknown }
		| { readonly ok: false; readonly message: string; readonly payload?: unknown },
		CommandChannelError
	>;
	readonly events: Stream.Stream<EventRecord, CommandChannelError, Scope.Scope>;
}

interface PublisherState {
	readonly seq: Ref.Ref<number>;
}

const nextSeq = (state: PublisherState): Effect.Effect<number> =>
	Ref.modify(state.seq, (n) => [n + 1, n + 1]);

/**
 * Build the publisher half. The events Stream is scope-bound:
 * pass it through `Stream.runDrain` inside a `Scope.use` or fork it
 * with `Effect.forkScoped` so the tail polling cleans up.
 */
export const makeCommandChannelPublisher = (
	paths: CommandChannelPaths,
): Effect.Effect<CommandChannelPublisher, CommandChannelError> =>
	Effect.gen(function* () {
		yield* ensureFile(paths.commandsFile);
		yield* ensureFile(paths.eventsFile);
		const state: PublisherState = { seq: yield* Ref.make(0) };
		const pid = selfPid();
		const host = nodeHostname();

		const publish = (
			command: EngineCommand,
		): Effect.Effect<PublishedCommand, CommandChannelError> =>
			Effect.gen(function* () {
				const seq = yield* nextSeq(state);
				const id = `${pid}-${seq}-${randomUUID().slice(0, 8)}`;
				const record: CommandRecord = {
					protocol: COMMAND_CHANNEL_PROTOCOL_VERSION,
					seq,
					id,
					at: Date.now(),
					publisherPid: pid,
					publisherHostname: host,
					command,
				};
				yield* appendRecord(paths.commandsFile, record);
				return { id };
			});

		const decodeEvent = (raw: unknown): EventRecord =>
			decodeUnknownSync(EventRecordSchema, raw, {
				source: 'command-channel event',
				mkError: (issue) => issue,
			});

		const events: Stream.Stream<EventRecord, CommandChannelError, Scope.Scope> = tailRecords(
			paths.eventsFile,
			(raw) => decodeEvent(raw),
			{ fromOffset: 'current', onDecodeError: 'skip' },
		);

		const findReply = (
			id: string,
		): Effect.Effect<
			Option.Option<Extract<EventRecord, { kind: 'ack' | 'error' }>>,
			CommandChannelError,
			Scope.Scope
		> =>
			// Start at 'start' so awaitCompletion picks up an ack that
			// landed before the await call attached. The filter by id is
			// the actual correlation; replaying old records is cheap.
			// `onDecodeError: 'skip'` keeps the tail alive across truncated /
			// corrupt lines from a peer's mid-flight atomic append, per
			// STYLE_GUIDE §20 NDJSON tolerance rule.
			Stream.runHead(
				tailRecords(paths.eventsFile, (raw) => decodeEvent(raw), {
					fromOffset: 'start',
					onDecodeError: 'skip',
				}).pipe(
					Stream.filter(
						(rec): rec is Extract<EventRecord, { kind: 'ack' | 'error' }> =>
							(rec.kind === 'ack' || rec.kind === 'error') && rec.correlatesTo === id,
					),
					Stream.take(1),
				),
			);

		const awaitCompletion = (
			id: string,
			options: { readonly timeoutMillis?: number } = {},
		): Effect.Effect<
			| { readonly ok: true; readonly payload?: unknown }
			| { readonly ok: false; readonly message: string; readonly payload?: unknown },
			CommandChannelError
		> => {
			const withScope = Effect.scoped(findReply(id));
			const final =
				options.timeoutMillis !== undefined
					? withScope.pipe(
							Effect.timeoutOption(`${options.timeoutMillis} millis`),
							Effect.map((outer) => Option.flatten(outer)),
						)
					: withScope;
			return final.pipe(
				Effect.map((reply) => {
					const inner = Option.getOrNull(reply);
					if (inner === null) {
						return options.timeoutMillis !== undefined
							? { ok: false as const, message: 'timed out waiting for ack' }
							: { ok: false as const, message: 'no reply' };
					}
					if (inner.kind === 'ack') {
						return inner.payload !== undefined
							? { ok: true as const, payload: inner.payload }
							: { ok: true as const };
					}
					return {
						ok: false as const,
						message: inner.detail ? `${inner.message}: ${inner.detail}` : inner.message,
						...(inner.payload !== undefined ? { payload: inner.payload } : {}),
					};
				}),
			);
		};

		return { publish, awaitCompletion, events };
	});

// -----------------------------------------------------------------------------
// Supervisor side
// -----------------------------------------------------------------------------

export interface CommandChannelSubscriberOptions {
	/** From which offset to start reading commands. Defaults to `current`
	 *  so a freshly-booted supervisor doesn't replay queued intents from
	 *  before it was alive. */
	readonly fromOffset?: 'start' | 'current';
	readonly pollMillis?: number;
}

/** Tail incoming commands. The supervisor wires its event hub through
 *  `publishEvent` so engine events appear on the events file. */
export interface CommandChannelSubscriber {
	readonly commands: Stream.Stream<CommandRecord, CommandChannelError, Scope.Scope>;
	readonly publishEvent: (event: unknown) => Effect.Effect<void, CommandChannelError>;
	readonly ack: (
		correlatesTo: string,
		detail?: string,
		payload?: unknown,
	) => Effect.Effect<void, CommandChannelError>;
	readonly fail: (
		correlatesTo: string,
		message: string,
		detail?: string,
		payload?: unknown,
	) => Effect.Effect<void, CommandChannelError>;
}

interface SubscriberState {
	readonly seq: Ref.Ref<number>;
}

const nextSubSeq = (state: SubscriberState): Effect.Effect<number> =>
	Ref.modify(state.seq, (n) => [n + 1, n + 1]);

/** Build the supervisor half. The commands Stream is scope-bound. */
export const makeCommandChannelSubscriber = (
	paths: CommandChannelPaths,
	options: CommandChannelSubscriberOptions = {},
): Effect.Effect<CommandChannelSubscriber, CommandChannelError> =>
	Effect.gen(function* () {
		yield* ensureFile(paths.commandsFile);
		yield* ensureFile(paths.eventsFile);
		const state: SubscriberState = { seq: yield* Ref.make(0) };

		const decodeCommand = (raw: unknown): CommandRecord =>
			decodeUnknownSync(CommandRecordSchema, raw, {
				source: 'command-channel command',
				mkError: (issue) => issue,
			});

		const commands: Stream.Stream<CommandRecord, CommandChannelError, Scope.Scope> = tailRecords(
			paths.commandsFile,
			(raw) => decodeCommand(raw),
			{
				fromOffset: options.fromOffset ?? 'current',
				pollMillis: options.pollMillis,
			},
		);

		const writeEvent = (record: EventRecord): Effect.Effect<void, CommandChannelError> =>
			appendRecord(paths.eventsFile, record);

		const publishEvent = (event: unknown): Effect.Effect<void, CommandChannelError> =>
			Effect.gen(function* () {
				const seq = yield* nextSubSeq(state);
				yield* writeEvent({
					protocol: COMMAND_CHANNEL_PROTOCOL_VERSION,
					seq,
					at: Date.now(),
					kind: 'engine',
					event,
				});
			});

		const ack = (
			correlatesTo: string,
			detail?: string,
			payload?: unknown,
		): Effect.Effect<void, CommandChannelError> =>
			Effect.gen(function* () {
				const seq = yield* nextSubSeq(state);
				yield* writeEvent({
					protocol: COMMAND_CHANNEL_PROTOCOL_VERSION,
					seq,
					at: Date.now(),
					kind: 'ack',
					correlatesTo,
					...(detail !== undefined ? { detail } : {}),
					...(payload !== undefined ? { payload } : {}),
				});
			});

		const fail = (
			correlatesTo: string,
			message: string,
			detail?: string,
			payload?: unknown,
		): Effect.Effect<void, CommandChannelError> =>
			Effect.gen(function* () {
				const seq = yield* nextSubSeq(state);
				yield* writeEvent({
					protocol: COMMAND_CHANNEL_PROTOCOL_VERSION,
					seq,
					at: Date.now(),
					kind: 'error',
					correlatesTo,
					message,
					...(detail !== undefined ? { detail } : {}),
					...(payload !== undefined ? { payload } : {}),
				});
			});

		return { commands, publishEvent, ack, fail };
	});
