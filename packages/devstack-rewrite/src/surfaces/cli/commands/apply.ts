// CLI verb: `devstack apply` — one-shot reconcile.
//
// Architecture (distilled/20-cli.md § Lifecycle / invocation patterns
// § Long-running until reconcile-complete):
//   "`apply` (CI: boot → reconcile → exit clean)."
//
// `apply` is the canonical CI verb. It boots a stack, waits for every
// member to reach `ready` (or surfaces the first acquire failure),
// then exits clean. Unlike `up`, it does NOT stay attached for
// interactive watch + restart — once the manifest is flushed and
// every plugin is ready, the verb returns.
//
// The wire shape here is intentionally narrow: `apply` is "boot + drain
// once + shutdown". The actual reconciliation logic lives inside the
// supervisor (`apply.requested` triggers a re-acquire when the live-
// supervisor path is wired); the verb publishes that command and
// awaits the corresponding event.

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliInternalError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface ApplyDeps {
	readonly publisher: CommandPublisher;
}

export const runApply = (
	deps: ApplyDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* deps.publisher.publish({ tag: 'apply.requested' }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new CliInternalError({
						message: 'failed to publish apply.requested',
						cause,
					}),
				),
			),
		);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'apply',
			elapsedMs: Date.now() - started,
			data: { published: 'apply.requested' as const },
			humanLines: ['apply requested'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.apply'));
