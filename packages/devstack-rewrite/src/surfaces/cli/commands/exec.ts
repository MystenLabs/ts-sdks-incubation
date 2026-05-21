// CLI verb: `devstack exec -- <command> [args...]`.
//
// Runs a child process with devstack's resolved process environment and
// mirrors the child status as the CLI status. This is intentionally a
// surface-local process runner: it does not call engine internals and it
// does not publish a supervisor command.

import { spawn } from 'node:child_process';

import { Effect } from 'effect';

import { type CliError, CliInternalError, CliUsageError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface ChildProcessResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface ExecDeps {
	readonly runChild: (argv: ReadonlyArray<string>) => Effect.Effect<ChildProcessResult, unknown>;
}

export const runNodeChildProcess = (
	argv: ReadonlyArray<string>,
): Effect.Effect<ChildProcessResult, unknown> =>
	Effect.callback<ChildProcessResult, unknown>((resume) => {
		const [command, ...args] = argv;
		if (command === undefined) {
			resume(Effect.fail(new Error('missing command')));
			return;
		}
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: 'inherit',
		});
		child.once('error', (error) => {
			resume(Effect.fail(error));
		});
		child.once('close', (exitCode, signal) => {
			resume(Effect.succeed({ exitCode, signal }));
		});
	});

export const runExec = (
	deps: ExecDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const childArgv = ctx.flags.rest;
		if (childArgv.length === 0) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'exec requires a command',
					hint: 'devstack exec -- <command> [args...]',
				}),
			);
		}
		const result = yield* deps.runChild(childArgv).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new CliInternalError({
						message: 'failed to run child process',
						cause,
					}),
				),
			),
		);
		const exitCode = mirrorExitCode(result);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'exec',
			elapsedMs: Date.now() - started,
			exitCode,
			data: {
				argv: childArgv,
				exitCode,
				signal: result.signal,
			},
			humanLines: [],
		});
		return { exitCode } as CommandResult;
	}).pipe(Effect.withSpan('cli.exec'));

const mirrorExitCode = (result: ChildProcessResult): number => {
	if (typeof result.exitCode === 'number') return result.exitCode;
	if (result.signal !== null) return signalExitCode(result.signal);
	return 1;
};

const signalExitCode = (signal: NodeJS.Signals): number => {
	switch (signal) {
		case 'SIGHUP':
			return 129;
		case 'SIGINT':
			return 130;
		case 'SIGTERM':
			return 143;
		default:
			return 1;
	}
};
