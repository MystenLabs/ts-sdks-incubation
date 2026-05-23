import { Effect } from 'effect';

import {
	type CliError,
	CliConfirmDeclinedError,
	CliConfirmRequiredError,
	CliInternalError,
	isCliError,
} from '../errors.ts';
import type { CommandContext } from './index.ts';

export interface ConfirmPromptInput {
	readonly verb: string;
	readonly prompt: string;
}

export type ConfirmPrompt = (input: ConfirmPromptInput) => Effect.Effect<boolean, unknown>;

export const confirmDestructive = (
	confirm: ConfirmPrompt,
	ctx: CommandContext,
	input: ConfirmPromptInput & { readonly skipWhenDryRun?: boolean },
): Effect.Effect<void, CliError> =>
	Effect.gen(function* () {
		if (input.skipWhenDryRun !== false && ctx.flags.dryRun) return;
		const { assumeYes, forbidPrompt, stdinIsTty } = ctx.flags.confirm;
		if (assumeYes) return;
		if (forbidPrompt || !stdinIsTty) {
			return yield* Effect.fail(
				new CliConfirmRequiredError({
					verb: input.verb,
					hint: 'rerun with --yes or run in a TTY to confirm interactively',
				}),
			);
		}
		const confirmed = yield* confirm({ verb: input.verb, prompt: input.prompt }).pipe(
			Effect.catch((cause: unknown) =>
				isCliError(cause)
					? Effect.fail(cause)
					: Effect.fail(
							new CliInternalError({
								message: `${input.verb} confirmation prompt failed`,
								cause,
							}),
						),
			),
		);
		if (!confirmed) {
			return yield* Effect.fail(
				new CliConfirmDeclinedError({
					verb: input.verb,
					hint: 'rerun with --yes to skip interactive confirmation',
				}),
			);
		}
	});
