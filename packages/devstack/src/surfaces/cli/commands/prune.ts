// CLI verb: `devstack prune` — cross-stack orphan cleanup.
//
// Architecture (distilled/20-cli.md § Subcommands § Teardown):
//   "prune — cross-stack inventory + bulk cleanup, including orphans,
//    repo-gone entries, interactive picker, and global passes over
//    images / router / fork cache."
//
// Two paths: published as a `prune.requested` command (the L3 prune
// orchestrator consumes); confirmation tier ensures `--yes` honors
// the non-TTY / `--no-input` policy.

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliConfirmRequiredError, CliInternalError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface PruneDeps {
	readonly publisher: CommandPublisher;
}

/**
 * Confirm-tier check. Architecture: "Tier-1 — y/N for routine,
 * Tier-2 — type-to-confirm for destructive-of-shared-state. Both
 * collapse to non-interactive failure modes that respect `--yes`,
 * `--no-input`, and stdin TTY state."
 *
 * Prune is Tier-1. The interactive path lives in a sibling module;
 * here we only handle the non-interactive contract.
 *
 * `--dry-run` short-circuits BEFORE the confirm check (architecture
 * invariant: "--dry-run must short-circuit before prompting").
 */
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
	// Interactive prompt path is intentionally stubbed at this layer
	// — the prompt library is lazy-loaded by the dispatcher.
	// Architecture: "Lazy-load the prompt library."
	return Effect.void;
};

export const runPrune = (
	deps: PruneDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* checkConfirm('prune', ctx);
		if (!ctx.flags.dryRun) {
			yield* deps.publisher
				.publish({ tag: 'prune.requested' })
				.pipe(
					Effect.catch((cause: unknown) =>
						Effect.fail(new CliInternalError({ message: 'prune publish failed', cause })),
					),
				);
		}
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'prune',
			elapsedMs: Date.now() - started,
			dryRun: ctx.flags.dryRun,
			data: {
				published: ctx.flags.dryRun ? null : ('prune.requested' as const),
				dryRun: ctx.flags.dryRun,
			},
			humanLines: ctx.flags.dryRun
				? ['[dry-run] would publish prune.requested']
				: ['prune requested'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.prune'));
