// CLI verb: `devstack codegen` — force codegen re-emit.
//
// Architecture (distilled/20-cli.md): codegen is a *peer surface*
// (L4) that subscribes to events and walks `Codegenable` decls. The
// CLI's job here is to trigger a re-emit — typically used in CI
// after a manifest version bump, or by developers after editing a
// codegen template.
//
// We publish a codegen-specific command to the live supervisor. First
// run codegen is owned by stack boot/apply; this command only forces a
// re-emit against the currently registered contributions.

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliInternalError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface CodegenDeps {
	readonly publisher: CommandPublisher;
}

export const runCodegen = (
	deps: CodegenDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		yield* deps.publisher.publish({ tag: 'codegen.requested' }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new CliInternalError({
						message: 'failed to publish codegen.requested',
						cause,
					}),
				),
			),
		);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'codegen',
			elapsedMs: Date.now() - started,
			data: { published: 'codegen.requested' as const },
			humanLines: ['codegen re-emit requested'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.codegen'));
