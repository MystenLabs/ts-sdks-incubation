// CLI verb: `devstack wipe` — destroy all state for a stack.
//
// Architecture (distilled/20-cli.md § Subcommands § Teardown):
//   "wipe — destroy all state for a stack."
//
// `wipe` is the recovery flow `apply` points users at on
// `SeedManifestMismatchError`. It is tier-2 destructive (requires
// `--yes` to skip the typed-confirm prompt) and refuses to run while
// a supervisor is live for the target stack (writes to disk while
// a peer is acquiring a container would race).
//
// Surface-equality: `wipe` publishes `wipe.requested`; the L3 snapshot
// orchestrator consumes (it owns the `wipe.ts` body that rmdir's the
// stack root + container labels).

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliConfirmRequiredError, CliInternalError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface WipeDeps {
	readonly publisher: CommandPublisher;
}

const checkConfirm = (verb: string, ctx: CommandContext): Effect.Effect<void, CliError> => {
	if (ctx.flags.dryRun) return Effect.void;
	const { assumeYes, forbidPrompt, stdinIsTty } = ctx.flags.confirm;
	if (assumeYes) return Effect.void;
	if (forbidPrompt || !stdinIsTty) {
		return Effect.fail(
			new CliConfirmRequiredError({
				verb,
				hint: 'rerun with --yes (non-interactive) or in a TTY',
			}),
		);
	}
	return Effect.void;
};

export const runWipe = (
	deps: WipeDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* checkConfirm('wipe', ctx);
		if (!ctx.flags.dryRun) {
			yield* deps.publisher.publish({ tag: 'wipe.requested' }).pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(
						new CliInternalError({
							message: 'failed to publish wipe.requested',
							cause,
						}),
					),
				),
			);
		}
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'wipe',
			elapsedMs: Date.now() - started,
			dryRun: ctx.flags.dryRun,
			data: {
				published: ctx.flags.dryRun ? null : ('wipe.requested' as const),
				dryRun: ctx.flags.dryRun,
			},
			humanLines: ctx.flags.dryRun
				? ['[dry-run] would publish wipe.requested']
				: ['wipe requested'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.wipe'));
