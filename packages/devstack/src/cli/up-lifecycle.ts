import { Effect, Queue } from 'effect';

import type { EngineCommand } from '../substrate/events.ts';
import { resolveMode, type RendererMode } from '../surfaces/tui/mode-detect.ts';
import type { CliRendererMode } from '../surfaces/cli/flags.ts';

export interface ResolveUpRendererModeInput {
	readonly cliRenderer: CliRendererMode | undefined;
	readonly stackRenderer: 'tui' | 'plain' | 'silent' | undefined;
	readonly stdoutIsTty: boolean;
}

const toRendererMode = (
	mode: CliRendererMode | 'tui' | 'plain' | 'silent' | undefined,
): RendererMode | undefined => {
	switch (mode) {
		case undefined:
			return undefined;
		case 'tui':
			return 'ink';
		case 'plain':
		case 'silent':
			return mode;
	}
};

export const resolveUpRendererMode = (input: ResolveUpRendererModeInput): RendererMode =>
	resolveMode({
		requested: toRendererMode(input.cliRenderer ?? input.stackRenderer),
		stdoutIsTty: input.stdoutIsTty,
	});

export const makeQueueCommandPublisher =
	(commands: Queue.Enqueue<EngineCommand>): ((command: EngineCommand) => void) =>
	(command) => {
		Effect.runFork(Queue.offer(commands, command));
	};
