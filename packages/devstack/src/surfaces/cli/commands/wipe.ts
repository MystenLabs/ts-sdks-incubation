// CLI verb: `devstack wipe` — destroy all state for a stack.
//
// Architecture (distilled/20-cli.md § Subcommands § Teardown):
//   "wipe — destroy all state for a stack."
//
// `wipe` is the recovery flow `apply` points users at on
// `SeedManifestMismatchError`. It is tier-2 destructive (requires
// `--yes` or an interactive TTY confirmation) and refuses to run while
// a supervisor is live for the target stack (writes to disk while
// a peer is acquiring a container would race).
//
// Surface-equality: `wipe` publishes `wipe.requested`; the L3 snapshot
// orchestrator consumes (it owns the `wipe.ts` body that rmdir's the
// stack root + container labels).

import { Effect } from 'effect';

import { type CliError, CliInternalError, isCliError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import { confirmDestructive, type ConfirmPrompt } from './confirm.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface WipeDeps {
	readonly wipe: () => Effect.Effect<void, unknown>;
	readonly confirm: ConfirmPrompt;
}

export const runWipe = (
	deps: WipeDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* confirmDestructive(deps.confirm, ctx, {
			verb: 'wipe',
			prompt: 'Wipe all devstack state for the selected stack?',
		});
		if (!ctx.flags.dryRun) {
			yield* deps.wipe().pipe(
				Effect.catch((cause: unknown) =>
					isCliError(cause)
						? Effect.fail(cause)
						: Effect.fail(
								new CliInternalError({
									message: 'wipe failed',
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
				dryRun: ctx.flags.dryRun,
			},
			humanLines: ctx.flags.dryRun
				? ['[dry-run] would wipe selected stack state']
				: ['stack state wiped'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.wipe'));
