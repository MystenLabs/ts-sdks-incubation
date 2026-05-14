// `devstack prune` — cross-stack cleanup surface.
//
// Where `devstack wipe` targets one (app, stack) inferred from the
// caller's cwd, `prune` is the way out of "I have docker volumes from
// six apps I'd already forgotten about". Three modes:
//
//   --list                          Print the same inventory as
//                                   `doctor`'s Inventory section but
//                                   without the preflight checks. Safe
//                                   in scripts.
//   --interactive (default)         Ink-based picker. Toggle stacks,
//                                   confirm, then prune. Refuses to run
//                                   on a non-TTY stdin so CI doesn't
//                                   hang waiting for keys.
//   --all-orphans --yes             Remove every (app, stack) whose
//                                   supervisor isn't currently running.
//   <app>/<stack> --yes             Remove one specific bucket. Lets
//                                   you target a stack from another app
//                                   without `cd`-ing into its repo.
//
// All four modes share `_prune-stack.pruneStack` for the actual
// teardown: containers, networks, volumes, state dir.
//
// A live supervisor lock is the single hard "no": we look up each
// stack's `state.json.lock`, `kill(pid, 0)` for liveness, and skip the
// row with `skipped: <app>/<stack> (running pid <N>)` on the way past.

import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { render } from 'ink';
import React from 'react';
import {
	collectInventory,
	formatBytes,
	isPidAlive,
	renderInventoryRow,
	renderTotals,
	totalsFor,
	type InventoryRow,
} from '../../internal/docker/inventory.js';
import { pruneStack, type PruneStackResult } from './_prune-stack.js';
import { PruneApp } from './_prune-ui.js';

const TARGET_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

const targetArg = Argument.string('target').pipe(
	Argument.withDescription("'<app>/<stack>' — non-interactive single-stack prune"),
	Argument.optional,
);

const yesFlag = Flag.boolean('yes').pipe(
	Flag.withDescription('Required for any mutating mode (target argument or --all-orphans)'),
	Flag.withDefault(false),
);

const listFlag = Flag.boolean('list').pipe(
	Flag.withDescription('Print the inventory and exit (no mutation, scriptable)'),
	Flag.withDefault(false),
);

const allOrphansFlag = Flag.boolean('all-orphans').pipe(
	Flag.withDescription("Remove every stack whose supervisor isn't running (requires --yes)"),
	Flag.withDefault(false),
);

const interactiveFlag = Flag.boolean('interactive').pipe(
	Flag.withDescription('Force the Ink picker even if other flags would imply non-interactive'),
	Flag.withDefault(false),
);

const keepSnapshotsFlag = Flag.boolean('keep-snapshots').pipe(
	Flag.withDescription("Don't delete labeled snapshots under snapshots/"),
	Flag.withDefault(false),
);

const imagesFlag = Flag.boolean('images').pipe(
	Flag.withDescription('Also `docker rmi` devstack-* images with no running containers'),
	Flag.withDefault(false),
);

// Decide which mode to run based on the flag combination. The decision
// is exhaustive so a stray combination (e.g. `--list --all-orphans`)
// resolves to a single mode rather than silently picking one over the
// other. Priority: `--list` > target arg > `--all-orphans` > default
// interactive.
type Mode =
	| { readonly kind: 'list' }
	| { readonly kind: 'target'; readonly app: string; readonly stack: string }
	| { readonly kind: 'all-orphans' }
	| { readonly kind: 'interactive' };

const resolveMode = (input: {
	readonly list: boolean;
	readonly target: Option.Option<string>;
	readonly allOrphans: boolean;
	readonly interactive: boolean;
}): Effect.Effect<Mode, Error> =>
	Effect.gen(function* () {
		if (input.list) return { kind: 'list' } as const;
		if (Option.isSome(input.target)) {
			const m = TARGET_RE.exec(input.target.value);
			if (m === null) {
				return yield* Effect.fail(
					new Error(
						`prune: target '${input.target.value}' must be '<app>/<stack>' (e.g. 'arena/main')`,
					),
				);
			}
			const [, app, stack] = m as unknown as [string, string, string];
			return { kind: 'target', app, stack } as const;
		}
		if (input.allOrphans) return { kind: 'all-orphans' } as const;
		return { kind: 'interactive' } as const;
	});

const renderPruneResult = (
	app: string,
	stack: string,
	result: PruneStackResult,
): string => {
	const killed = result.killedContainers.length;
	const networks = result.removedNetworks.length;
	const volumes = result.removedVolumes.length;
	const state = result.removedStatePaths.length;
	return `pruned ${app}/${stack}: ${killed} container${killed === 1 ? '' : 's'}, ${networks} network${networks === 1 ? '' : 's'}, ${volumes} volume${volumes === 1 ? '' : 's'}, ${state} state ${state === 1 ? 'path' : 'paths'}`;
};

// Live-supervisor refusal point. Mirrors the `state.json.lock`
// liveness check the inventory does — re-runs it here in case the
// inventory snapshot is stale by the time the user confirms.
const findRunningRow = (
	rows: ReadonlyArray<InventoryRow>,
	app: string,
	stack: string,
): InventoryRow | undefined => {
	const match = rows.find((r) => r.app === app && r.stack === stack);
	if (match === undefined) return undefined;
	if (match.runningPid === undefined) return undefined;
	if (!isPidAlive(match.runningPid)) return undefined;
	return match;
};

const pruneRows = (
	rows: ReadonlyArray<InventoryRow>,
	options: { readonly keepSnapshots: boolean; readonly images: boolean },
) =>
	Effect.gen(function* () {
		for (const row of rows) {
			const running = findRunningRow(rows, row.app, row.stack);
			if (running !== undefined) {
				yield* Console.log(`skipped: ${row.app}/${row.stack} (running pid ${running.runningPid})`);
				continue;
			}
			const result = yield* pruneStack({
				app: row.app,
				stack: row.stack,
				keepSnapshots: options.keepSnapshots,
				removeImages: options.images,
				extraStateDirs: row.stateDirs,
			});
			yield* Console.log(renderPruneResult(row.app, row.stack, result));
		}
	});

// Inventory-print path used by `--list`.
const printInventory = (rows: ReadonlyArray<InventoryRow>) =>
	Effect.gen(function* () {
		if (rows.length === 0) {
			yield* Console.log('(no devstack-labelled resources)');
			return;
		}
		for (const row of rows) {
			yield* Console.log(renderInventoryRow(row));
		}
		yield* Console.log('');
		yield* Console.log(renderTotals(totalsFor(rows)));
	});

// Mount the Ink picker, await the user's choice, then return the
// selected rows. We unmount BEFORE resolving so the calling Effect
// can stream `Console.log` lines without fighting Ink for the TTY.
const runInteractivePicker = (
	rows: ReadonlyArray<InventoryRow>,
): Effect.Effect<ReadonlyArray<InventoryRow>> =>
	Effect.callback<ReadonlyArray<InventoryRow>>((resume) => {
		const instance = render(
			React.createElement(PruneApp, {
				rows,
				onSubmit: (selected: ReadonlyArray<InventoryRow>) => {
					instance.unmount();
					resume(Effect.succeed(selected));
				},
				onQuit: () => {
					instance.unmount();
					resume(Effect.succeed([] as ReadonlyArray<InventoryRow>));
				},
			}),
			// Picker doesn't need patchConsole — we only `Console.log` the
			// result lines AFTER unmount.
			{ exitOnCtrlC: false },
		);
	});

export const pruneCommand = Command.make(
	'prune',
	{
		target: targetArg,
		yes: yesFlag,
		list: listFlag,
		allOrphans: allOrphansFlag,
		interactive: interactiveFlag,
		keepSnapshots: keepSnapshotsFlag,
		images: imagesFlag,
	},
	(args) =>
		Effect.gen(function* () {
			const mode = yield* resolveMode({
				list: args.list,
				target: args.target,
				allOrphans: args.allOrphans,
				interactive: args.interactive,
			});

			const rows = yield* collectInventory();

			if (mode.kind === 'list') {
				yield* printInventory(rows);
				return;
			}

			if (mode.kind === 'target') {
				if (!args.yes) {
					yield* Console.error(
						`devstack prune: --yes is required to prune ${mode.app}/${mode.stack}`,
					);
					return yield* Effect.fail(new Error('prune: --yes required'));
				}
				const running = findRunningRow(rows, mode.app, mode.stack);
				if (running !== undefined) {
					yield* Console.error(
						`prune: refusing to remove ${mode.app}/${mode.stack} — supervisor is running (pid ${running.runningPid}). Stop it first.`,
					);
					return yield* Effect.fail(new Error('prune: target supervisor still running'));
				}
				const matchingInventory = rows.find(
					(r) => r.app === mode.app && r.stack === mode.stack,
				);
				const result = yield* pruneStack({
					app: mode.app,
					stack: mode.stack,
					keepSnapshots: args.keepSnapshots,
					removeImages: args.images,
					extraStateDirs:
						matchingInventory !== undefined ? matchingInventory.stateDirs : undefined,
				});
				yield* Console.log(renderPruneResult(mode.app, mode.stack, result));
				return;
			}

			if (mode.kind === 'all-orphans') {
				if (!args.yes) {
					yield* Console.error(
						'devstack prune --all-orphans: --yes is required to remove every orphaned stack',
					);
					return yield* Effect.fail(new Error('prune: --yes required'));
				}
				const orphans = rows.filter(
					(r) => r.runningPid === undefined || !isPidAlive(r.runningPid),
				);
				if (orphans.length === 0) {
					yield* Console.log('prune: no orphaned stacks to remove');
					return;
				}
				const totals = totalsFor(orphans);
				yield* Console.log(
					`pruning ${orphans.length} orphan${orphans.length === 1 ? '' : 's'}${totals.bytes > 0 ? ` (~${formatBytes(totals.bytes)})` : ''}`,
				);
				yield* pruneRows(orphans, { keepSnapshots: args.keepSnapshots, images: args.images });
				return;
			}

			// Default: interactive picker. Hard requirement on a real TTY
			// so a CI shell can't hang waiting for keypresses.
			if (process.stdin.isTTY !== true) {
				yield* Console.error(
					'devstack prune: interactive mode requires a TTY. Use `--list`, `<app>/<stack> --yes`, or `--all-orphans --yes`.',
				);
				return yield* Effect.fail(new Error('prune: interactive mode without TTY'));
			}
			if (rows.length === 0) {
				yield* Console.log('(no devstack-labelled resources to prune)');
				return;
			}
			// Skip the picker if every row is running; nothing to select.
			const orphans = rows.filter((r) => r.runningPid === undefined);
			if (orphans.length === 0) {
				yield* Console.log(
					'prune: every stack has a running supervisor; stop one to free it up first.',
				);
				return;
			}
			const selected = yield* runInteractivePicker(rows);
			if (selected.length === 0) {
				yield* Console.log('prune: nothing selected, exiting.');
				return;
			}
			yield* pruneRows(selected, { keepSnapshots: args.keepSnapshots, images: args.images });
		}),
).pipe(
	Command.withDescription(
		'Inventory + interactive cross-stack cleanup. `--list` to print, `--interactive` to pick, `<app>/<stack> --yes` to target, `--all-orphans --yes` to nuke every idle stack.',
	),
);
