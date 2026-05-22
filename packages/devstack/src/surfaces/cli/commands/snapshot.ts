// CLI verb: `devstack snapshot {save|restore|list|delete}`.
//
// Architecture (distilled/20-cli.md § Subcommands § Persistence):
//   "snapshot save / restore / list / delete — capture, rehydrate,
//    enumerate, remove point-in-time captures of a stack."
//
// Surface-equality: snapshot is a peer command on the typed command
// channel (`snapshot.capture` / `restore` / `list` / `delete`). The
// CLI publishes; the L3 snapshot orchestrator (architecture § L3)
// consumes — same code path for TUI / programmable API.

import { Effect } from 'effect';

import {
	type CliError,
	CliSnapshotAmbiguousError,
	CliInternalError,
	CliSnapshotNotFoundError,
	CliUsageError,
	isCliError,
} from '../errors.ts';
import { takePositional, takeValueFlag } from '../flags.ts';
import { emitSuccess } from '../output.ts';
import { confirmDestructive, type ConfirmPrompt } from './confirm.ts';
import type { CommandContext, CommandResult } from './index.ts';

/** Snapshot read seam. The list verb reads the catalog without going
 *  through the command channel — same observation discipline as
 *  `status`: read-only views are equal across surfaces. */
export interface SnapshotReader {
	readonly list: () => Effect.Effect<ReadonlyArray<SnapshotEntry>>;
	readonly resolve: (snapshotRef: string) => Effect.Effect<SnapshotResolveResult>;
}

export interface SnapshotEntry {
	readonly snapshotId: string;
	readonly name: string | null;
	readonly createdAt: number;
	readonly size: number | null;
}

export type SnapshotResolveResult =
	| { readonly tag: 'found'; readonly entry: SnapshotEntry }
	| { readonly tag: 'not-found' }
	| {
			readonly tag: 'ambiguous';
			readonly snapshotRef: string;
			readonly matches: ReadonlyArray<SnapshotEntry>;
	  };

export interface SnapshotCaptureResult {
	readonly snapshotId: string;
	readonly name: string;
}

export interface SnapshotDeps {
	readonly reader: SnapshotReader;
	readonly capture: (args: {
		readonly snapshotId?: string;
		readonly name?: string;
		readonly configPath?: string;
	}) => Effect.Effect<SnapshotCaptureResult, unknown>;
	readonly restore: (snapshotId: string) => Effect.Effect<void, unknown>;
	readonly delete: (snapshotId: string) => Effect.Effect<void, unknown>;
	readonly confirm: ConfirmPrompt;
}

/** Snapshot subcommand dispatcher. `ctx.flags.rest` holds the
 *  sub-verb + verb-local arguments. */
export const runSnapshot = (
	deps: SnapshotDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const [sub, ...rest] = ctx.flags.rest;
		switch (sub) {
			case 'save':
				return yield* runSnapshotSave(deps, ctx, rest);
			case 'restore':
				return yield* runSnapshotRestore(deps, ctx, rest);
			case 'list':
				return yield* runSnapshotList(deps, ctx);
			case 'delete':
				return yield* runSnapshotDelete(deps, ctx, rest);
			default:
				return yield* Effect.fail(
					new CliUsageError({
						message: `unknown snapshot subcommand: ${sub ?? '(missing)'}`,
						hint: 'try: snapshot save [name] | restore <name-or-id> | list | delete <name-or-id>',
					}),
				);
		}
	}).pipe(Effect.withSpan('cli.snapshot'));

const runSnapshotSave = (
	deps: SnapshotDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const { value: flagName, tail: afterName } = takeValueFlag(rest, 'name');
		const { head: positionalName, tail: afterSnapshotName } = takePositional(afterName);
		const extra = afterSnapshotName.find((tok) => !tok.startsWith('-'));
		if (extra !== undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: `unexpected snapshot save argument: ${extra}`,
					hint: 'try: snapshot save [name]',
				}),
			);
		}
		if (flagName !== undefined && positionalName !== undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'snapshot save accepts a name either positionally or with --name, not both',
					hint: 'try: snapshot save [name]',
				}),
			);
		}
		const name = flagName ?? positionalName;
		const captured = yield* deps
			.capture({
				...(name === undefined ? {} : { name }),
				...(ctx.flags.configPath === undefined ? {} : { configPath: ctx.flags.configPath }),
			})
			.pipe(
				Effect.catch((cause: unknown) =>
					isCliError(cause)
						? Effect.fail(cause)
						: isSnapshotInputError(cause)
							? Effect.fail(snapshotInputCliError(cause))
						: Effect.fail(new CliInternalError({ message: 'snapshot capture failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot save',
			elapsedMs: Date.now() - started,
			data: {
				snapshotId: captured.snapshotId,
				name: captured.name,
			},
			humanLines: [`snapshot saved ${captured.name} (${captured.snapshotId})`],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runSnapshotRestore = (
	deps: SnapshotDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const snapshotRef = rest.find((tok) => !tok.startsWith('-'));
		if (snapshotRef === undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'snapshot restore requires a snapshot name or id',
					hint: 'snapshot list to enumerate available names and ids',
				}),
			);
		}
		const resolved = yield* deps.reader.resolve(snapshotRef);
		if (resolved.tag === 'not-found') {
			return yield* Effect.fail(new CliSnapshotNotFoundError({ snapshotRef }));
		}
		if (resolved.tag === 'ambiguous') {
			return yield* Effect.fail(
				new CliSnapshotAmbiguousError({
					snapshotRef,
					matches: resolved.matches.map((entry) => entry.snapshotId),
				}),
			);
		}
		const entry = resolved.entry;
		const snapshotId = entry.snapshotId;
		yield* confirmDestructive(deps.confirm, ctx, {
			verb: 'snapshot restore',
			prompt:
				entry.name === null
					? `Restore snapshot ${snapshotId} and replace current stack state?`
					: `Restore snapshot ${entry.name} (${snapshotId}) and replace current stack state?`,
			skipWhenDryRun: false,
		});
		yield* deps
			.restore(snapshotId)
			.pipe(
				Effect.catch((cause: unknown) =>
					isCliError(cause)
						? Effect.fail(cause)
						: Effect.fail(new CliInternalError({ message: 'snapshot restore failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot restore',
			elapsedMs: Date.now() - started,
			data: { snapshotId, name: entry.name },
			humanLines: [
				entry.name === null
					? `snapshot restored ${snapshotId}`
					: `snapshot restored ${entry.name} (${snapshotId})`,
			],
		});
		return { exitCode: 0 } as CommandResult;
	});

const runSnapshotList = (
	deps: SnapshotDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const entries = yield* deps.reader.list();
		const humanLines =
			entries.length === 0
				? ['(no snapshots)']
				: entries.map(
						(e) =>
							`${e.name ?? '(unnamed)'}  ${e.snapshotId}  ${new Date(e.createdAt).toISOString()}`,
					);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot list',
			elapsedMs: Date.now() - started,
			data: { entries },
			humanLines,
		});
		return { exitCode: 0 } as CommandResult;
	});

const runSnapshotDelete = (
	deps: SnapshotDeps,
	ctx: CommandContext,
	rest: ReadonlyArray<string>,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const snapshotRef = rest.find((tok) => !tok.startsWith('-'));
		if (snapshotRef === undefined) {
			return yield* Effect.fail(
				new CliUsageError({ message: 'snapshot delete requires a snapshot name or id' }),
			);
		}
		const resolved = yield* deps.reader.resolve(snapshotRef);
		if (resolved.tag === 'not-found') {
			return yield* Effect.fail(new CliSnapshotNotFoundError({ snapshotRef }));
		}
		if (resolved.tag === 'ambiguous') {
			return yield* Effect.fail(
				new CliSnapshotAmbiguousError({
					snapshotRef,
					matches: resolved.matches.map((entry) => entry.snapshotId),
				}),
			);
		}
		const entry = resolved.entry;
		const snapshotId = entry.snapshotId;
		yield* confirmDestructive(deps.confirm, ctx, {
			verb: 'snapshot delete',
			prompt:
				entry.name === null
					? `Delete snapshot ${snapshotId}?`
					: `Delete snapshot ${entry.name} (${snapshotId})?`,
			skipWhenDryRun: false,
		});
		yield* deps
			.delete(snapshotId)
			.pipe(
				Effect.catch((cause: unknown) =>
					isCliError(cause)
						? Effect.fail(cause)
						: Effect.fail(new CliInternalError({ message: 'snapshot delete failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot delete',
			elapsedMs: Date.now() - started,
			data: { snapshotId, name: entry.name },
			humanLines: [
				entry.name === null
					? `snapshot deleted ${snapshotId}`
					: `snapshot deleted ${entry.name} (${snapshotId})`,
			],
		});
		return { exitCode: 0 } as CommandResult;
	});

interface SnapshotInputErrorShape {
	readonly _tag: 'SnapshotIdError';
	readonly operation: string;
	readonly field: string;
	readonly value: string;
	readonly detail: string;
}

const isSnapshotInputError = (value: unknown): value is SnapshotInputErrorShape =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly _tag?: unknown })._tag === 'SnapshotIdError';

const snapshotInputCliError = (error: SnapshotInputErrorShape): CliUsageError =>
	new CliUsageError({
		message: `invalid snapshot ${error.field} for ${error.operation}: ${error.value}`,
		hint: error.detail,
	});
