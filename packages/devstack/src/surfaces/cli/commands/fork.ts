// CLI verb: `devstack fork {status|seed|advance|replay|cache}` —
// sui-fork subcommands.
//
// Architecture: fork mode is the sui-local node configured to replay
// from a known seed checkpoint. The fork-specific commands manipulate
// the local fork process's notion of time / checkpoint position.
//
// Per locked decision (notes/parity-matrix.md top-5 blockers), fork's
// scope here is partial — fork-greeting is illustrative, not cutover-
// required. The verbs publish typed commands; the supervisor's fork
// orchestration consumes (per `plugins/sui/fork-orchestration.ts`).

import { Effect } from 'effect';

import type { CommandPublisher } from './command-channel.ts';
import { type CliError, CliInternalError, CliUsageError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface ForkDeps {
	readonly publisher: CommandPublisher;
}

export const runFork = (
	deps: ForkDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const [sub, ...rest] = ctx.flags.rest;
		switch (sub) {
			case 'status':
				return yield* runForkStatus(deps, ctx);
			case 'advance':
				return yield* runForkAdvance(deps, ctx, rest);
			case 'seed':
				return yield* runForkSeed(deps, ctx, rest);
			case 'replay':
				return yield* runForkReplay(deps, ctx, rest);
			case 'cache':
				return yield* runForkCache(deps, ctx, rest);
			default:
				return yield* Effect.fail(
					new CliUsageError({
						message: `unknown fork subcommand: ${sub ?? '(missing)'}`,
						hint: 'try: fork status | advance --ms <n> | seed list | replay --to <cp> | cache list | cache prune',
					}),
				);
		}
	}).pipe(Effect.withSpan('cli.fork'));

const runForkStatus = (
	deps: ForkDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		void deps; // status reads state via the projection (status verb) — fork is partial scope.
		const started = Date.now();
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'fork status',
			elapsedMs: Date.now() - started,
			data: { partial: true as const },
			humanLines: ['fork status is read via `devstack status`; per-fork details TBD'],
		});
		return { exitCode: 0 } as CommandResult;
	});

const parseMsArg = (rest: ReadonlyArray<string>): number | null => {
	const idx = rest.findIndex((tok) => tok === '--ms');
	if (idx >= 0 && idx + 1 < rest.length) {
		const v = Number(rest[idx + 1]);
		return Number.isFinite(v) ? v : null;
	}
	const positional = rest.find((tok) => !tok.startsWith('-'));
	if (positional !== undefined) {
		const v = Number(positional);
		return Number.isFinite(v) ? v : null;
	}
	return null;
};

const runForkAdvance = (
	deps: ForkDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const ms = parseMsArg(rest);
		if (ms === null) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'fork advance requires a millisecond count',
					hint: 'devstack fork advance --ms <n>',
				}),
			);
		}
		yield* deps.publisher.publish({ tag: 'advance-clock.requested', toMillis: ms }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new CliInternalError({
						message: 'failed to publish advance-clock.requested',
						cause,
					}),
				),
			),
		);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'fork advance',
			elapsedMs: Date.now() - started,
			data: { advanceMs: ms },
			humanLines: [`fork advance requested (+${ms}ms)`],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runForkSeed = (
	deps: ForkDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		void deps;
		const started = Date.now();
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'fork seed',
			elapsedMs: Date.now() - started,
			data: { partial: true as const, args: rest },
			humanLines: ['fork seed inspection is partial scope (pending parity-matrix fork pass)'],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runForkReplay = (
	deps: ForkDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		void deps;
		const started = Date.now();
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'fork replay',
			elapsedMs: Date.now() - started,
			data: { partial: true as const, args: rest },
			humanLines: ['fork replay is partial scope (pending parity-matrix fork pass)'],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runForkCache = (
	deps: ForkDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		void deps;
		const started = Date.now();
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'fork cache',
			elapsedMs: Date.now() - started,
			data: { partial: true as const, args: rest },
			humanLines: ['fork cache inspection is partial scope (pending parity-matrix fork pass)'],
		});
		return { exitCode: 0 } as CommandResult;
	});
