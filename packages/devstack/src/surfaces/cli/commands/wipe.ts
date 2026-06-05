// CLI verb: `devstack wipe` — destroy all state for a stack.
//
// Architecture (distilled/20-cli.md § Subcommands § Teardown):
//   "wipe — destroy all state for a stack."
//
// `wipe` is the recovery flow `apply` points users at when stale
// on-disk state needs a clean reset. It is tier-2 destructive (requires
// `--yes` or an interactive TTY confirmation) and refuses to run while
// a supervisor is live for the target stack (writes to disk while
// a peer is acquiring a container would race).
//
// Surface-equality: `wipe` publishes `wipe.requested`; the L3 snapshot
// orchestrator consumes (it owns the `wipe.ts` body that rmdir's the
// stack root + container labels).

import { Effect } from 'effect';

import type { WipeTargets } from '../../../orchestrators/snapshot/index.ts';
import { type CliError, CliInternalError, isCliError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import { confirmDestructive, type ConfirmPrompt } from './confirm.ts';
import type { CommandContext, CommandResult } from './index.ts';

export type { WipeTargets } from '../../../orchestrators/snapshot/index.ts';

export interface WipeDeps {
	readonly wipe: () => Effect.Effect<void, unknown>;
	/** Read-only enumeration of the concrete targets a real wipe would
	 *  remove (containers, network/volume label scope, the on-disk stack
	 *  tree). Drives `--dry-run`. Optional so a deps
	 *  builder that cannot enumerate (or a test fixture) still works —
	 *  the dry-run then falls back to a generic preview line. */
	readonly plan?: () => Effect.Effect<WipeTargets, unknown>;
	readonly confirm: ConfirmPrompt;
}

/** Human-readable preview of what a real wipe would delete. Mirrors the
 *  orchestrator's teardown order (containers → networks/volumes →
 *  runtime tree) so the operator reads the plan in the same sequence the
 *  wipe executes. */
const dryRunLines = (targets: WipeTargets): ReadonlyArray<string> => {
	const lines: Array<string> = [`[dry-run] would wipe ${targets.app}/${targets.stack}:`];
	if (targets.containers.length > 0) {
		lines.push(`  containers (${targets.containers.length}):`);
		for (const name of targets.containers) lines.push(`    - ${name}`);
	} else {
		lines.push('  containers: (none running/created)');
	}
	lines.push(
		`  networks: all managed (label devstack.app=${targets.networkLabelMatch.app},devstack.stack=${targets.networkLabelMatch.stack})`,
	);
	lines.push(
		`  volumes: all managed (label devstack.app=${targets.volumeLabelMatch.app},devstack.stack=${targets.volumeLabelMatch.stack})`,
	);
	if (targets.onDiskPaths.length > 0) {
		lines.push(`  on-disk (${targets.onDiskPaths.length}):`);
		for (const path of targets.onDiskPaths) lines.push(`    - ${path}`);
	} else {
		lines.push(`  on-disk: (stack root ${targets.stackRoot} has no removable state)`);
	}
	if (targets.preserved.length > 0) {
		lines.push(`  preserved: ${targets.preserved.join(', ')}`);
	}
	return lines;
};

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

		if (ctx.flags.dryRun) {
			// Enumerate (read-only) so the preview lists the concrete
			// containers / networks / volumes / on-disk state a real wipe
			// would remove. A plan failure is non-fatal for a dry-run — the
			// worst case is a less-detailed preview — so it degrades to the
			// generic line rather than failing the command.
			const targets =
				deps.plan === undefined
					? null
					: yield* deps.plan().pipe(Effect.catch(() => Effect.succeed(null)));
			yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
				command: 'wipe',
				elapsedMs: Date.now() - started,
				dryRun: true,
				data: {
					dryRun: true,
					...(targets === null ? {} : { targets }),
				},
				humanLines:
					targets === null ? ['[dry-run] would wipe selected stack state'] : dryRunLines(targets),
			});
			return { exitCode: 0 } as CommandResult;
		}

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
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'wipe',
			elapsedMs: Date.now() - started,
			dryRun: false,
			data: {
				dryRun: false,
			},
			humanLines: ['stack state wiped'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.wipe'));
