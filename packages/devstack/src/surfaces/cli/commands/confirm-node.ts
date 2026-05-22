import { stderr, stdin } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { Effect } from 'effect';

import { CliInternalError } from '../errors.ts';
import type { ConfirmPrompt } from './confirm.ts';

export const nodeConfirmPrompt: ConfirmPrompt = (input) =>
	Effect.tryPromise({
		try: async () => {
			const rl = createInterface({ input: stdin, output: stderr });
			try {
				const answer = await rl.question(`${input.prompt} Type y to continue: `);
				return answer.trim().toLowerCase() === 'y';
			} finally {
				rl.close();
			}
		},
		catch: (cause) =>
			new CliInternalError({
				message: `${input.verb} confirmation prompt failed`,
				cause,
			}),
	});
