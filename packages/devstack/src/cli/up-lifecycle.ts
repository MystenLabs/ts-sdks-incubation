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

export interface QueueCommandPublisherOptions {
	readonly scheduleHardExit?: (exitCode: number) => void;
}

const scheduleProcessExit = (exitCode: number): void => {
	setImmediate(() => {
		process.exit(exitCode);
	});
};

export const makeQueueCommandPublisher =
	(
		commands: Queue.Enqueue<EngineCommand>,
		options: QueueCommandPublisherOptions = {},
	): ((command: EngineCommand) => void) =>
	(command) => {
		if (command.tag === 'shutdown.hardKillRequested') {
			(options.scheduleHardExit ?? scheduleProcessExit)(command.exitCode);
		}
		Effect.runFork(Queue.offer(commands, command));
	};
