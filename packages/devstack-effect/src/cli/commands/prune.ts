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
	renderClassificationTally,
	renderInventoryRow,
	renderTotals,
	totalsFor,
	type InventoryRow,
} from '../../internal/docker/inventory.js';
import { pruneStack, removeLabelledImagesNotInUse, type PruneStackResult } from './_prune-stack.js';
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

const includeImagesFlag = Flag.boolean('include-images').pipe(
	Flag.withDescription(
		'Also remove every image carrying the devstack.image=true label that no running container uses',
	),
	Flag.withDefault(false),
);

const abandonedFlag = Flag.boolean('abandoned').pipe(
	Flag.withDescription(
		'Remove every stack classified `abandoned` (the recorded repoPath no longer exists on disk)',
	),
	Flag.withDefault(false),
);

const staleFlag = Flag.string('stale').pipe(
	Flag.withDescription(
		"Remove every stack whose last-seen timestamp is older than the given duration (e.g. '30d', '12h', '45m')",
	),
	Flag.optional,
);

const appFilterFlag = Flag.string('app').pipe(
	Flag.withDescription(
		'Filter all modes (list / interactive / abandoned / stale / all-orphans) by app name',
	),
	Flag.optional,
);

const dryRunFlag = Flag.boolean('dry-run').pipe(
	Flag.withDescription('Print what would happen without removing anything'),
	Flag.withDefault(false),
);

// Tiny duration parser — accepts `<int>(s|m|h|d)`. Anything more
// exotic (e.g. compound `1d12h`) is a sign the user wants real
// timestamp filtering; we punt with a friendly error.
export const parseDuration = (raw: string): { ms: number } | { error: string } => {
	const m = /^(\d+)([smhd])$/.exec(raw.trim());
	if (m === null) {
		return {
			error: `--stale: '${raw}' must look like '30d' / '12h' / '45m' / '90s'`,
		};
	}
	const value = Number.parseInt(m[1] ?? '0', 10);
	if (!Number.isFinite(value) || value <= 0) {
		return { error: `--stale: '${raw}' must be a positive integer + unit` };
	}
	const unit = m[2];
	const ms =
		unit === 's'
			? value * 1000
			: unit === 'm'
				? value * 60_000
				: unit === 'h'
					? value * 3_600_000
					: value * 86_400_000;
	return { ms };
};

// Decide which mode to run based on the flag combination. The decision
// is exhaustive so a stray combination (e.g. `--list --all-orphans`)
// resolves to a single mode rather than silently picking one over the
// other.
//
// Priority order — narrowest filter wins so a user that types
// `prune --abandoned --list` still gets list (read-only beats write).
// `--list` > target arg > `--abandoned` > `--stale` > `--all-orphans`
// > default interactive.
type Mode =
	| { readonly kind: 'list' }
	| { readonly kind: 'target'; readonly app: string; readonly stack: string }
	| { readonly kind: 'abandoned' }
	| { readonly kind: 'stale'; readonly maxAgeMs: number }
	| { readonly kind: 'all-orphans' }
	| { readonly kind: 'interactive' };

const resolveMode = (input: {
	readonly list: boolean;
	readonly target: Option.Option<string>;
	readonly abandoned: boolean;
	readonly stale: Option.Option<string>;
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
		if (input.abandoned) return { kind: 'abandoned' } as const;
		if (Option.isSome(input.stale)) {
			const parsed = parseDuration(input.stale.value);
			if ('error' in parsed) return yield* Effect.fail(new Error(parsed.error));
			return { kind: 'stale', maxAgeMs: parsed.ms } as const;
		}
		if (input.allOrphans) return { kind: 'all-orphans' } as const;
		return { kind: 'interactive' } as const;
	});

const renderPruneResult = (app: string, stack: string, result: PruneStackResult): string => {
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
	options: {
		readonly keepSnapshots: boolean;
		readonly images: boolean;
		readonly dryRun: boolean;
	},
) =>
	Effect.gen(function* () {
		for (const row of rows) {
			const running = findRunningRow(rows, row.app, row.stack);
			if (running !== undefined) {
				yield* Console.log(`skipped: ${row.app}/${row.stack} (running pid ${running.runningPid})`);
				continue;
			}
			if (options.dryRun) {
				yield* Console.log(
					`would prune ${row.app}/${row.stack} [${row.classification}]: ${row.containers.length} containers, ${row.networks.length} networks, ${row.volumes.length} volumes`,
				);
				continue;
			}
			const result = yield* pruneStack({
				app: row.app,
				stack: row.stack,
				network: row.registryEntry?.network ?? 'localnet',
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
		yield* Console.log(renderClassificationTally(rows));
	});

interface ClassificationModeArgs {
	readonly keepSnapshots: boolean;
	readonly images: boolean;
	readonly includeImages: boolean;
	readonly dryRun: boolean;
	readonly yes: boolean;
}

// Shared body for `--abandoned`, `--stale`, `--all-orphans`. Selects
// rows by `filter`, prints a tally, then calls `pruneRows`. `dryRun`
// skips the `--yes` requirement (printing is read-only).
const runClassificationMode = (input: {
	readonly label: string;
	readonly filter: (r: InventoryRow) => boolean;
	readonly rows: ReadonlyArray<InventoryRow>;
	readonly args: ClassificationModeArgs;
	/** Skip the `filter` step (`rows` is already filtered). */
	readonly preFiltered?: boolean;
}) =>
	Effect.gen(function* () {
		const matched = input.preFiltered ? input.rows : input.rows.filter(input.filter);
		if (matched.length === 0) {
			yield* Console.log(`prune --${input.label}: nothing matches`);
			return;
		}
		if (!input.args.yes && !input.args.dryRun) {
			yield* Console.error(
				`devstack prune --${input.label}: --yes (or --dry-run) is required to remove ${matched.length} stack${matched.length === 1 ? '' : 's'}`,
			);
			return yield* Effect.fail(new Error('prune: --yes required'));
		}
		const totals = totalsFor(matched);
		yield* Console.log(
			`pruning ${matched.length} ${input.label} stack${matched.length === 1 ? '' : 's'}${totals.bytes > 0 ? ` (~${formatBytes(totals.bytes)})` : ''}`,
		);
		yield* pruneRows(matched, {
			keepSnapshots: input.args.keepSnapshots,
			images: input.args.images,
			dryRun: input.args.dryRun,
		});
		yield* maybePruneImages(input.args.includeImages, input.args.dryRun);
	});

// `--include-images` post-pass. Distinct from `--images` (which is
// scoped to the per-stack `pruneStack` call): this one walks every
// `devstack.image=true`-labelled image on the host and removes those
// not referenced by any container. Dry-run prints what would happen.
const maybePruneImages = (enabled: boolean, dryRun: boolean) =>
	Effect.gen(function* () {
		if (!enabled) return;
		if (dryRun) {
			yield* Console.log(
				'would also remove every devstack.image=true-labelled image not in use by any container',
			);
			return;
		}
		const removed = yield* removeLabelledImagesNotInUse();
		yield* Console.log(
			`removed ${removed.length} labelled image${removed.length === 1 ? '' : 's'} (devstack.image=true, no live container)`,
		);
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
		includeImages: includeImagesFlag,
		abandoned: abandonedFlag,
		stale: staleFlag,
		appFilter: appFilterFlag,
		dryRun: dryRunFlag,
	},
	(args) =>
		Effect.gen(function* () {
			const mode = yield* resolveMode({
				list: args.list,
				target: args.target,
				abandoned: args.abandoned,
				stale: args.stale,
				allOrphans: args.allOrphans,
				interactive: args.interactive,
			});

			const allRows = yield* collectInventory();
			// `--app <name>` narrows every non-target mode. Target mode
			// already names a specific (app, stack), so the filter is a
			// no-op there.
			const appFilter = Option.getOrUndefined(args.appFilter);
			const rows = appFilter !== undefined ? allRows.filter((r) => r.app === appFilter) : allRows;

			if (mode.kind === 'list') {
				yield* printInventory(rows);
				return;
			}

			if (mode.kind === 'target') {
				if (!args.yes && !args.dryRun) {
					yield* Console.error(
						`devstack prune: --yes (or --dry-run) is required to prune ${mode.app}/${mode.stack}`,
					);
					return yield* Effect.fail(new Error('prune: --yes required'));
				}
				const running = findRunningRow(allRows, mode.app, mode.stack);
				if (running !== undefined) {
					yield* Console.error(
						`prune: refusing to remove ${mode.app}/${mode.stack} — supervisor is running (pid ${running.runningPid}). Stop it first.`,
					);
					return yield* Effect.fail(new Error('prune: target supervisor still running'));
				}
				const matchingInventory = allRows.find((r) => r.app === mode.app && r.stack === mode.stack);
				if (args.dryRun) {
					const m = matchingInventory;
					yield* Console.log(
						`would prune ${mode.app}/${mode.stack} [${m?.classification ?? 'untracked'}]: ${m?.containers.length ?? 0} containers, ${m?.networks.length ?? 0} networks, ${m?.volumes.length ?? 0} volumes`,
					);
					return;
				}
				const result = yield* pruneStack({
					app: mode.app,
					stack: mode.stack,
					network: matchingInventory?.registryEntry?.network ?? 'localnet',
					keepSnapshots: args.keepSnapshots,
					removeImages: args.images,
					extraStateDirs: matchingInventory !== undefined ? matchingInventory.stateDirs : undefined,
				});
				yield* Console.log(renderPruneResult(mode.app, mode.stack, result));
				yield* maybePruneImages(args.includeImages, args.dryRun);
				return;
			}

			if (mode.kind === 'abandoned') {
				yield* runClassificationMode({
					label: 'abandoned',
					filter: (r) => r.classification === 'abandoned',
					rows,
					args,
				});
				return;
			}

			if (mode.kind === 'stale') {
				// `stale` rows are registry entries unseen in the last
				// 30 days. The CLI flag accepts an arbitrary duration —
				// re-classify here against the cutoff the user specified,
				// independent of the registry's hard-coded threshold.
				const now = Date.now();
				const cutoff = now - mode.maxAgeMs;
				const matched = rows.filter((r) => {
					if (r.runningPid !== undefined) return false;
					if (r.registryEntry === undefined) return false;
					const lastSeen = Date.parse(r.registryEntry.lastSeen);
					if (!Number.isFinite(lastSeen)) return false;
					return lastSeen < cutoff;
				});
				yield* runClassificationMode({
					label: `stale (>${mode.maxAgeMs / 86_400_000}d)`,
					filter: () => false,
					rows: matched,
					args,
					preFiltered: true,
				});
				return;
			}

			if (mode.kind === 'all-orphans') {
				// "All non-active" — every row except live supervisors.
				// Includes abandoned + stale + dormant + untracked.
				const orphans = rows.filter(
					(r) =>
						r.classification !== 'active' &&
						(r.runningPid === undefined || !isPidAlive(r.runningPid)),
				);
				yield* runClassificationMode({
					label: 'all-orphans',
					filter: () => false,
					rows: orphans,
					args,
					preFiltered: true,
				});
				return;
			}

			// Default: interactive picker. Hard requirement on a real TTY
			// so a CI shell can't hang waiting for keypresses.
			if (process.stdin.isTTY !== true) {
				yield* Console.error(
					'devstack prune: interactive mode requires a TTY. Use `--list`, `<app>/<stack> --yes`, `--abandoned --yes`, `--stale 30d --yes`, or `--all-orphans --yes`.',
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
			yield* pruneRows(selected, {
				keepSnapshots: args.keepSnapshots,
				images: args.images,
				dryRun: args.dryRun,
			});
			yield* maybePruneImages(args.includeImages, args.dryRun);
		}),
).pipe(
	Command.withDescription(
		'Inventory + interactive cross-stack cleanup. `--list` to print, `--interactive` to pick, `<app>/<stack> --yes` to target, `--all-orphans --yes` to nuke every idle stack.',
	),
);
