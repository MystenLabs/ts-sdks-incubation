// CLI verb: `devstack down` — graceful shutdown.
//
// Architecture (distilled/20-cli.md): the CLI does NOT call engine
// methods directly. It publishes `shutdown.requested` on the typed
// command channel; the engine consumes. Same code path whether the
// command arrives from CLI, TUI, or programmable API.
//
// "No `restart` verb." (Architecture decision § Explicitly absent.)
// `down` is a one-shot — it enqueues the command and reports the
// outcome; long-running drain happens in the engine.

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliInternalError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface DownDeps {
	readonly publisher: CommandPublisher;
}

/**
 * Publish a `shutdown.requested` command. Returns immediately after
 * the publish; the actual drain is the engine's responsibility (the
 * supervisor's command loop flips its shutdown latch; the outer
 * scope close cascades teardown).
 */
export const runDown = (
	deps: DownDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* deps.publisher.publish({ tag: 'shutdown.requested' }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new CliInternalError({
						message: 'failed to publish shutdown.requested',
						cause,
					}),
				),
			),
		);
		const elapsedMs = Date.now() - started;
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'down',
			elapsedMs,
			data: { published: 'shutdown.requested' as const },
			humanLines: ['shutdown requested'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.down'));
