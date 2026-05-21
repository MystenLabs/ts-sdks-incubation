// CLI verb: `devstack config` — print resolved config.
//
// Observational. Loads the user's `devstack.config.ts`, resolves all
// active overrides (flag > env > active-stack > default), and emits
// the projection. Never publishes a command.
//
// JSON output is canonical: it is the same shape the programmable
// API exposes for "what is my config right now?", so build
// integrations can pin against it.

import { Effect } from 'effect';

import type { LoadedConfig } from './up.ts';
import type { CliError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';
import type { ConfigLoader } from './up.ts';

export interface ConfigDeps {
	readonly loader: ConfigLoader;
}

export const runConfig = (
	deps: ConfigDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const loaded: LoadedConfig = yield* deps.loader.load(ctx.flags.configPath);
		const data = {
			resolvedConfigPath: loaded.resolvedConfigPath,
			app: ctx.flags.app ?? null,
			stack: ctx.flags.stack ?? null,
			stateDir: ctx.flags.stateDir ?? null,
			network: ctx.flags.network ?? null,
		};
		const humanLines = [
			`config:    ${data.resolvedConfigPath}`,
			`app:       ${data.app ?? '(default)'}`,
			`stack:     ${data.stack ?? '(default)'}`,
			`stateDir:  ${data.stateDir ?? '(default)'}`,
			`network:   ${data.network ?? '(default)'}`,
		];
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'config',
			elapsedMs: Date.now() - started,
			data,
			humanLines,
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.config'));
