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

import type { CommandPublisher } from './command-channel.ts';
import {
	type CliError,
	CliInternalError,
	CliSnapshotNotFoundError,
	CliUsageError,
} from '../errors.ts';
import { takeValueFlag } from '../flags.ts';
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
	readonly publisher: CommandPublisher;
	readonly reader: SnapshotReader;
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
			case 'wipe':
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
		const { value: label } = takeValueFlag(rest, 'label');
		yield* deps.publisher
			.publish({ tag: 'snapshot.capture', label })
			.pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(new CliInternalError({ message: 'snapshot capture publish failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot save',
			elapsedMs: Date.now() - started,
			data: { published: 'snapshot.capture' as const, label: label ?? null },
			humanLines: [
				label ? `snapshot capture requested (label: ${label})` : 'snapshot capture requested',
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
		yield* deps.publisher
			.publish({ tag: 'snapshot.restore', snapshotId })
			.pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(new CliInternalError({ message: 'snapshot restore publish failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot restore',
			elapsedMs: Date.now() - started,
			data: { published: 'snapshot.restore' as const, snapshotId },
			humanLines: [`snapshot restore requested (id: ${snapshotId})`],
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
		yield* deps.publisher
			.publish({ tag: 'snapshot.delete', snapshotId })
			.pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(new CliInternalError({ message: 'snapshot delete publish failed', cause })),
				),
			);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'snapshot delete',
			elapsedMs: Date.now() - started,
			data: { published: 'snapshot.delete' as const, snapshotId },
			humanLines: [`snapshot delete requested (id: ${snapshotId})`],
		});
		return { exitCode: 0 } as CommandResult;
	});
