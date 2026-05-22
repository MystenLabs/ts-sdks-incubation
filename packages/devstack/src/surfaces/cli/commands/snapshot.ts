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
	CliInternalError,
	CliSnapshotNotFoundError,
	CliUsageError,
	isCliError,
} from '../errors.ts';
import { takePositional, takeValueFlag } from '../flags.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

/** Snapshot read seam. The list verb reads the catalog without going
 *  through the command channel — same observation discipline as
 *  `status`: read-only views are equal across surfaces. */
export interface SnapshotReader {
	readonly list: () => Effect.Effect<ReadonlyArray<SnapshotEntry>>;
	readonly resolve: (snapshotRef: string) => Effect.Effect<SnapshotEntry | null>;
}

export interface SnapshotEntry {
	readonly snapshotId: string;
	readonly label: string | null;
	readonly createdAt: number;
	readonly size: number | null;
}

export interface SnapshotDeps {
	readonly reader: SnapshotReader;
	readonly capture: (args: {
		readonly snapshotId?: string;
		readonly label?: string;
		readonly configPath?: string;
	}) => Effect.Effect<void, unknown>;
	readonly restore: (snapshotId: string) => Effect.Effect<void, unknown>;
	readonly delete: (snapshotId: string) => Effect.Effect<void, unknown>;
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
						hint: 'try: snapshot save | restore <id> | list | delete <id>',
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
		const { value: label, tail: afterLabel } = takeValueFlag(rest, 'label');
		const { head: snapshotId, tail: afterSnapshotId } = takePositional(afterLabel);
		const extra = afterSnapshotId.find((tok) => !tok.startsWith('-'));
		if (extra !== undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: `unexpected snapshot save argument: ${extra}`,
					hint: 'try: snapshot save [id] [--label <label>]',
				}),
			);
		}
		yield* deps
			.capture({
				...(snapshotId === undefined ? {} : { snapshotId }),
				...(label === undefined ? {} : { label }),
				...(ctx.flags.configPath === undefined ? {} : { configPath: ctx.flags.configPath }),
			})
			.pipe(
				Effect.catch((cause: unknown) =>
					isCliError(cause)
						? Effect.fail(cause)
						: Effect.fail(new CliInternalError({ message: 'snapshot capture failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot save',
			elapsedMs: Date.now() - started,
			data: {
				snapshotId: snapshotId ?? null,
				label: label ?? null,
			},
			humanLines: [
				snapshotId
					? label
						? `snapshot capture requested (id: ${snapshotId}, label: ${label})`
						: `snapshot capture requested (id: ${snapshotId})`
					: label
						? `snapshot capture requested (label: ${label})`
						: 'snapshot capture requested',
			],
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
					message: 'snapshot restore requires a snapshot id or label',
					hint: 'snapshot list to enumerate available ids',
				}),
			);
		}
		const entry = yield* deps.reader.resolve(snapshotRef);
		if (entry === null) {
			return yield* Effect.fail(new CliSnapshotNotFoundError({ snapshotRef }));
		}
		const snapshotId = entry.snapshotId;
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
			data: { snapshotId },
			humanLines: [`snapshot restored (id: ${snapshotId})`],
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
							`${e.snapshotId}${e.label ? ` [${e.label}]` : ''}  ${new Date(
								e.createdAt,
							).toISOString()}`,
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
				new CliUsageError({ message: 'snapshot delete requires a snapshot id' }),
			);
		}
		const entry = yield* deps.reader.resolve(snapshotRef);
		if (entry === null) {
			return yield* Effect.fail(new CliSnapshotNotFoundError({ snapshotRef }));
		}
		const snapshotId = entry.snapshotId;
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
			data: { snapshotId },
			humanLines: [`snapshot deleted (id: ${snapshotId})`],
		});
		return { exitCode: 0 } as CommandResult;
	});
