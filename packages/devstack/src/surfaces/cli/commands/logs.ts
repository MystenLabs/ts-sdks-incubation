// CLI verb: `devstack logs <plugin>` — tail logs for a plugin.
//
// Architecture (distilled/20-cli.md § Output formats § Streaming):
//   "Streaming verbs emit one record per event with stable line
//    semantics (ISO timestamp + payload)."
//
// Logs is an event-subscription verb. It subscribes to the typed
// `log.appended` event stream, filters by `pluginKey`, and projects
// each event into either an envelope-per-event (JSON mode) or a
// human-readable line. The subscription seam lives in
// `command-channel.ts` so the CLI never reaches into the engine's
// log internals.

import { Effect } from 'effect';

import type { EngineEvent } from '../../../substrate/events.ts';
import type { EventSubscriber } from './command-channel.ts';
import { type CliError, CliUsageError } from '../errors.ts';
import { takeValueFlag } from '../flags.ts';
import { emitSuccess, serializeEnvelope } from '../output.ts';
import { streamingEvent } from '../envelope.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface LogsDeps {
	readonly subscriber: EventSubscriber;
	/** Shutdown latch — fires on SIGINT so the streaming loop can
	 *  unsubscribe cleanly. */
	readonly shutdown: Effect.Effect<void>;
}

export const runLogs = (
	deps: LogsDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const [pluginKey, ...rest] = ctx.flags.rest;
		if (pluginKey === undefined) {
			return yield* Effect.fail(new CliUsageError({ message: 'logs requires a plugin key' }));
		}
		const { value: levelFilter } = takeValueFlag(rest, 'level');

		const onEvent = (event: EngineEvent): Effect.Effect<void> => {
			if (event.tag !== 'log.appended') return Effect.void;
			if (event.pluginKey !== (pluginKey as never)) return Effect.void;
			if (levelFilter !== undefined && event.level !== levelFilter) return Effect.void;
			return ctx.flags.outputMode === 'json'
				? // Streaming verbs use `StreamingEvent` records with
					// `kind: 'event'` so a consumer piping through `jq` can
					// filter per-event records from the closing envelope
					// (surfaces review §1). The closing `Envelope` carries
					// `ok: true` + `data.closed: true`; events carry
					// `kind: 'event'`.
					ctx.io.writeStdout(
						serializeEnvelope(
							streamingEvent({
								command: 'logs',
								at: event.at,
								data: {
									pluginKey: event.pluginKey as string,
									level: event.level,
									line: event.line,
								},
							}),
						),
					)
				: ctx.io.writeStdout(
						`${new Date(event.at).toISOString()} ${event.level.toUpperCase()} ${event.line}`,
					);
		};

		const { unsubscribe } = yield* deps.subscriber.subscribe(onEvent);
		yield* deps.shutdown;
		yield* unsubscribe;

		// Streaming verbs render their own per-event output. The closing
		// success envelope is a single "stream closed" record.
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'logs',
			elapsedMs: Date.now() - started,
			data: { pluginKey, closed: true as const },
			humanLines: [],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.logs'));
