// Cross-process command channel — wire protocol.
//
// Architecture § Cross-process safety protocol § Command channel:
//   The CLI / TUI / programmable API publish typed commands to a
//   running supervisor; the supervisor publishes typed events back. The
//   channel is filesystem-backed (append-only NDJSON) so a peer
//   process can attach without IPC handshakes.
//
// Two files live under `<stackRoot>/`:
//   - `commands.ndjson`  — caller appends; supervisor tails.
//   - `events.ndjson`    — supervisor appends; callers tail.
//
// Each record is one JSON object per line, schema-versioned for forward
// compatibility. Records carry a monotonically increasing sequence
// number (per file) plus a per-record id that the publisher uses to
// correlate event replies (e.g. `down` publishes a command, then waits
// for an `event` carrying `correlatesTo: <same id>`).
//
// `EngineCommand` / `EngineEvent` payloads are NOT re-decoded on the
// wire: the publisher API accepts typed commands, and both payload
// kinds round-trip faithfully through JSON (closed string-tag-
// discriminated unions with JSON-safe payloads). The channel validates
// the envelope (`protocol`, `seq`, `id`, `correlatesTo`) and treats
// the inner payload as `Schema.Unknown`. A future hardening pass can
// promote the inner payloads to typed schemas without changing this
// file's contract.

import { Schema } from 'effect';

/** Protocol version. Bump on incompatible record-shape changes. */
export const COMMAND_CHANNEL_PROTOCOL_VERSION = 1 as const;

/** Per-record envelope written to `commands.ndjson`. */
export const CommandRecordSchema = Schema.Struct({
	protocol: Schema.Literal(COMMAND_CHANNEL_PROTOCOL_VERSION),
	seq: Schema.Number,
	id: Schema.String,
	at: Schema.Number,
	publisherPid: Schema.Number,
	publisherHostname: Schema.String,
	command: Schema.Unknown,
});

export type CommandRecord = Schema.Schema.Type<typeof CommandRecordSchema>;

/** Per-record envelope written to `events.ndjson`. The supervisor emits
 *  one record per `EngineEvent` plus synthetic `ack` / `error`
 *  responses when the inner handler reports completion or failure for a
 *  correlatable command.
 *
 *  `correlatesTo` carries the originating `CommandRecord.id` for `ack`
 *  / `error`. Other event kinds (engine events) carry `null`.
 */
export const EventRecordSchema = Schema.Union([
	Schema.Struct({
		protocol: Schema.Literal(COMMAND_CHANNEL_PROTOCOL_VERSION),
		seq: Schema.Number,
		at: Schema.Number,
		kind: Schema.Literal('engine'),
		event: Schema.Unknown,
	}),
	Schema.Struct({
		protocol: Schema.Literal(COMMAND_CHANNEL_PROTOCOL_VERSION),
		seq: Schema.Number,
		at: Schema.Number,
		kind: Schema.Literal('ack'),
		correlatesTo: Schema.String,
		detail: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		protocol: Schema.Literal(COMMAND_CHANNEL_PROTOCOL_VERSION),
		seq: Schema.Number,
		at: Schema.Number,
		kind: Schema.Literal('error'),
		correlatesTo: Schema.String,
		message: Schema.String,
		detail: Schema.optional(Schema.String),
	}),
]);

export type EventRecord = Schema.Schema.Type<typeof EventRecordSchema>;
