// CLI verb: `devstack stack {list|new|use|drop|drop-fork}` — multi-
// stack management.
//
// Architecture (distilled/20-cli.md § Multi-stack): each named stack
// has its own runtime root subdirectory and its own roster /
// container claims / snapshots. `stack list` enumerates the
// directories under `<runtimeRoot>/stacks/`. `stack new` creates a
// fresh empty stack root. `stack use` writes the name to
// `<runtimeRoot>/stacks/.active`. `stack drop` removes a stack's
// state (refuses if a supervisor is live). `drop-fork` is the
// fork-specific variant — drops a stack whose chain id is the fork
// network, leaving local-network siblings alone.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';

import { type CliError, CliInternalError, CliUsageError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';
import { probeSupervisorPresence } from './supervisor-presence.ts';

export interface StackEntry {
	readonly name: string;
	readonly active: boolean;
	readonly stackRoot: string;
}

export interface StackDeps {
	/** Resolve the stack collection root — typically
	 *  `<DEVSTACK_STATE_DIR>/stacks` or `~/.devstack/stacks`. */
	readonly resolveAppRoot: () => Effect.Effect<string>;
}

const ACTIVE_FILE = '.active';

const readActiveStack = (appRoot: string): string | null => {
	const path = join(appRoot, ACTIVE_FILE);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, 'utf8').trim() || null;
	} catch {
		return null;
	}
};

const writeActiveStack = (appRoot: string, name: string): void => {
	mkdirSync(appRoot, { recursive: true });
	writeFileSync(join(appRoot, ACTIVE_FILE), name, 'utf8');
};

const listStacks = (appRoot: string): ReadonlyArray<StackEntry> => {
	if (!existsSync(appRoot)) return [];
	const active = readActiveStack(appRoot);
	const out: StackEntry[] = [];
	for (const entry of readdirSync(appRoot)) {
		if (entry.startsWith('.')) continue;
		const stackRoot = join(appRoot, entry);
		try {
			if (!statSync(stackRoot).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push({ name: entry, active: entry === active, stackRoot });
	}
	return out;
};

export const runStack = (
	deps: StackDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const [sub, ...rest] = ctx.flags.rest;
		switch (sub) {
			case 'list':
				return yield* runStackList(deps, ctx);
			case 'new':
				return yield* runStackNew(deps, ctx, rest);
			case 'use':
				return yield* runStackUse(deps, ctx, rest);
			case 'drop':
				return yield* runStackDrop(deps, ctx, rest, { forksOnly: false });
			case 'drop-fork':
				return yield* runStackDrop(deps, ctx, rest, { forksOnly: true });
			default:
				return yield* Effect.fail(
					new CliUsageError({
						message: `unknown stack subcommand: ${sub ?? '(missing)'}`,
						hint: 'try: stack list | new <name> | use <name> | drop <name> | drop-fork <name>',
					}),
				);
		}
	}).pipe(Effect.withSpan('cli.stack'));

const runStackList = (
	deps: StackDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const appRoot = yield* deps.resolveAppRoot();
		const entries = listStacks(appRoot);
		const humanLines =
			entries.length === 0
				? ['(no stacks)']
				: entries.map((e) => `${e.active ? '*' : ' '} ${e.name}`);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'stack list',
			elapsedMs: Date.now() - started,
			data: { entries },
			humanLines,
		});
		return { exitCode: 0 } as CommandResult;
	});

const runStackNew = (
	deps: StackDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const name = rest.find((tok) => !tok.startsWith('-'));
		if (name === undefined) {
			return yield* Effect.fail(new CliUsageError({ message: 'stack new requires a name' }));
		}
		const appRoot = yield* deps.resolveAppRoot();
		const stackRoot = join(appRoot, name);
		yield* Effect.try({
			try: () => mkdirSync(stackRoot, { recursive: true }),
			catch: (cause) =>
				new CliInternalError({
					message: `failed to create stack root: ${stackRoot}`,
					cause,
				}),
		});
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'stack new',
			elapsedMs: Date.now() - started,
			data: { name, stackRoot },
			humanLines: [`created stack: ${name}`],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runStackUse = (
	deps: StackDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const name = rest.find((tok) => !tok.startsWith('-'));
		if (name === undefined) {
			return yield* Effect.fail(new CliUsageError({ message: 'stack use requires a name' }));
		}
		const appRoot = yield* deps.resolveAppRoot();
		yield* Effect.try({
			try: () => writeActiveStack(appRoot, name),
			catch: (cause) =>
				new CliInternalError({
					message: `failed to write active-stack file`,
					cause,
				}),
		});
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'stack use',
			elapsedMs: Date.now() - started,
			data: { name },
			humanLines: [`active stack: ${name}`],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runStackDrop = (
	deps: StackDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
	options: { readonly forksOnly: boolean },
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const name = rest.find((tok) => !tok.startsWith('-'));
		if (name === undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: `stack ${options.forksOnly ? 'drop-fork' : 'drop'} requires a name`,
				}),
			);
		}
		const appRoot = yield* deps.resolveAppRoot();
		const stackRoot = join(appRoot, name);
		if (!existsSync(stackRoot)) {
			yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
				command: options.forksOnly ? 'stack drop-fork' : 'stack drop',
				elapsedMs: Date.now() - started,
				data: { name, dropped: false as const },
				humanLines: [`stack not found: ${name}`],
			});
			return { exitCode: 0 } as CommandResult;
		}
		// Refuse to drop while a supervisor holds the stack.
		const rosterFile = join(stackRoot, 'roster.json');
		const presence = yield* probeSupervisorPresence(rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (presence.live) {
			return yield* Effect.fail(
				new CliInternalError({
					message: `supervisor live for ${name} (pid=${presence.pid}); stop it first`,
				}),
			);
		}
		yield* Effect.try({
			try: () => rmSync(stackRoot, { recursive: true, force: true }),
			catch: (cause) =>
				new CliInternalError({
					message: `failed to remove stack root: ${stackRoot}`,
					cause,
				}),
		});
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: options.forksOnly ? 'stack drop-fork' : 'stack drop',
			elapsedMs: Date.now() - started,
			data: { name, dropped: true as const },
			humanLines: [`dropped stack: ${name}`],
		});
		return { exitCode: 0 } as CommandResult;
	});
