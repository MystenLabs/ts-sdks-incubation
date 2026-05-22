// CLI verb: `devstack prune` — cross-stack Docker cleanup.
//
// The rewrite initially wired this command to snapshot-catalog prune
// only. That path can report success while leaving ordinary stale
// containers, networks, and volumes untouched. This command owns the
// operator surface; production injects a Docker-label inventory and
// remover that understand both current labels and pre-rewrite labels.

import { Effect } from 'effect';

import {
	type CliError,
	CliConfirmRequiredError,
	CliInternalError,
	CliUsageError,
	isCliError,
} from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export interface PruneGroup {
	readonly key: string;
	readonly app: string;
	readonly stack: string;
	readonly live: boolean;
	readonly livePids: ReadonlyArray<number>;
	readonly shared: boolean;
	readonly containers: number;
	readonly runningContainers: number;
	readonly networks: number;
	readonly volumes: number;
	readonly images: number;
}

export interface PruneTotals {
	readonly groups: number;
	readonly liveGroups: number;
	readonly sharedGroups: number;
	readonly containers: number;
	readonly runningContainers: number;
	readonly networks: number;
	readonly volumes: number;
	readonly images: number;
}

export interface PruneInventory {
	readonly groups: ReadonlyArray<PruneGroup>;
	readonly totals: PruneTotals;
}

export interface PruneResourceScope {
	readonly containers: boolean;
	readonly networks: boolean;
	readonly volumes: boolean;
	readonly images: boolean;
}

export interface PruneTargetSelection {
	readonly groupKeys: ReadonlyArray<string>;
	readonly resources: PruneResourceScope;
}

export interface PruneSelection extends PruneTargetSelection {
	readonly dryRun: boolean;
}

export interface PruneSummary {
	readonly inspectedGroups: number;
	readonly selectedGroups: number;
	readonly skippedLiveGroups: number;
	readonly containersRemoved: number;
	readonly networksRemoved: number;
	readonly networksSkipped: number;
	readonly volumesRemoved: number;
	readonly imagesRemoved: number;
}

export type PruneOutcome = { readonly kind: 'completed'; readonly summary: PruneSummary };

export interface PruneDeps {
	readonly inventory: () => Effect.Effect<PruneInventory, unknown>;
	readonly prune: (selection: PruneSelection) => Effect.Effect<PruneOutcome, unknown>;
	readonly select: (
		inventory: PruneInventory,
		resources: PruneResourceScope,
	) => Effect.Effect<PruneTargetSelection, unknown>;
}

export interface PruneRunOptions {
	readonly mode: 'auto' | 'list' | 'all';
	readonly resources: PruneResourceScope;
}

export const DEFAULT_PRUNE_RESOURCES: PruneResourceScope = {
	containers: true,
	networks: true,
	volumes: true,
	images: false,
};

export const summarizePruneGroups = (groups: ReadonlyArray<PruneGroup>): PruneTotals => {
	let liveGroups = 0;
	let sharedGroups = 0;
	let containers = 0;
	let runningContainers = 0;
	let networks = 0;
	let volumes = 0;
	let images = 0;
	for (const group of groups) {
		if (group.live) liveGroups += 1;
		if (group.shared) sharedGroups += 1;
		containers += group.containers;
		runningContainers += group.runningContainers;
		networks += group.networks;
		volumes += group.volumes;
		images += group.images;
	}
	return {
		groups: groups.length,
		liveGroups,
		sharedGroups,
		containers,
		runningContainers,
		networks,
		volumes,
		images,
	};
};

export const summarizePruneGroupsForResources = (
	groups: ReadonlyArray<PruneGroup>,
	resources: PruneResourceScope,
): PruneTotals => {
	const totals = summarizePruneGroups(groups);
	return {
		...totals,
		containers: resources.containers ? totals.containers : 0,
		runningContainers: resources.containers ? totals.runningContainers : 0,
		networks: resources.networks ? totals.networks : 0,
		volumes: resources.volumes ? totals.volumes : 0,
		images: resources.images ? totals.images : 0,
	};
};

export const hasPruneResources = (resources: PruneResourceScope): boolean =>
	resources.containers || resources.networks || resources.volumes || resources.images;

export const groupResourceCountForResources = (
	group: PruneGroup,
	resources: PruneResourceScope,
): number =>
	(resources.containers ? group.containers : 0) +
	(resources.networks ? group.networks : 0) +
	(resources.volumes ? group.volumes : 0) +
	(resources.images ? group.images : 0);

export const defaultPruneSelection = (
	inventory: PruneInventory,
	resources: PruneResourceScope = DEFAULT_PRUNE_RESOURCES,
): ReadonlyArray<string> =>
	inventory.groups
		.filter((group) => !group.live && groupResourceCountForResources(group, resources) > 0)
		.map((group) => group.key);

const requireBulkConfirm = (verb: string, ctx: CommandContext): Effect.Effect<void, CliError> => {
	if (ctx.flags.dryRun) return Effect.void;
	if (ctx.flags.confirm.assumeYes) return Effect.void;
	return Effect.fail(
		new CliConfirmRequiredError({
			verb,
			hint: 'rerun with --yes for non-interactive bulk prune, or omit --all in a TTY to pick rows interactively',
		}),
	);
};

const requireInteractive = (ctx: CommandContext): Effect.Effect<void, CliError> => {
	if (ctx.flags.confirm.stdinIsTty && !ctx.flags.confirm.forbidPrompt) return Effect.void;
	return Effect.fail(
		new CliConfirmRequiredError({
			verb: 'prune',
			hint: 'use --list, --dry-run, or --all --yes in non-interactive shells',
		}),
	);
};

const formatGroupLine = (group: PruneGroup): string => {
	const state =
		group.live && group.livePids.length > 0
			? `live pid ${group.livePids.join(',')}`
			: group.live
				? 'live'
				: group.shared
					? 'shared'
					: 'idle';
	const running = group.runningContainers > 0 ? `, ${group.runningContainers} running` : '';
	const images = group.images > 0 ? `, ${group.images} image(s)` : '';
	return `  ${group.app}/${group.stack}  ${state}  ${group.containers} container(s)${running}, ${group.networks} network(s), ${group.volumes} volume(s)${images}`;
};

const inventoryLines = (inventory: PruneInventory): ReadonlyArray<string> => {
	if (inventory.groups.length === 0) return ['(no devstack-labelled Docker resources)'];
	return [
		`devstack prune inventory: ${inventory.totals.groups} group(s), ${inventory.totals.containers} container(s), ${inventory.totals.networks} network(s), ${inventory.totals.volumes} volume(s), ${inventory.totals.images} image(s)`,
		...inventory.groups.map(formatGroupLine),
	];
};

const completedLine = (summary: PruneSummary, dryRun: boolean): string => {
	const prefix = dryRun ? '[dry-run] would prune' : 'prune completed';
	const skippedNetworks =
		summary.networksSkipped > 0 ? `, ${summary.networksSkipped} network(s) still in use` : '';
	return `${prefix}: ${summary.selectedGroups} group(s), ${summary.containersRemoved} container(s), ${summary.networksRemoved} network(s), ${summary.volumesRemoved} volume(s), ${summary.imagesRemoved} image(s), ${summary.skippedLiveGroups} live group(s) skipped${skippedNetworks}`;
};

const mapUnknownPruneError = (cause: unknown): Effect.Effect<never, CliError> =>
	isCliError(cause)
		? Effect.fail(cause)
		: Effect.fail(new CliInternalError({ message: 'prune failed', cause }));

export const runPrune = (
	deps: PruneDeps,
	ctx: CommandContext,
	options: PruneRunOptions = { mode: 'auto', resources: DEFAULT_PRUNE_RESOURCES },
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const inventory = yield* deps.inventory().pipe(Effect.catch(mapUnknownPruneError));

		if (options.mode === 'list') {
			yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
				command: 'prune',
				elapsedMs: Date.now() - started,
				dryRun: true,
				data: { mode: 'list' as const, inventory },
				humanLines: inventoryLines(inventory),
			});
			return { exitCode: 0 } as CommandResult;
		}

		if (!hasPruneResources(options.resources)) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'prune requires at least one resource type',
					hint: 'enable containers, networks, volumes, or images',
				}),
			);
		}

		let selected: PruneTargetSelection;
		if (ctx.flags.dryRun || options.mode === 'all' || ctx.flags.confirm.assumeYes) {
			yield* requireBulkConfirm('prune', ctx);
			selected = {
				groupKeys: defaultPruneSelection(inventory, options.resources),
				resources: options.resources,
			};
		} else {
			yield* requireInteractive(ctx);
			selected = yield* deps
				.select(inventory, options.resources)
				.pipe(Effect.catch(mapUnknownPruneError));
		}

		if (!hasPruneResources(selected.resources)) {
			return yield* Effect.fail(
				new CliUsageError({
					message: 'prune requires at least one selected resource type',
					hint: 'toggle at least one resource type before confirming',
				}),
			);
		}

		if (selected.groupKeys.length === 0) {
			yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
				command: 'prune',
				elapsedMs: Date.now() - started,
				dryRun: ctx.flags.dryRun,
				data: {
					mode: options.mode,
					dryRun: ctx.flags.dryRun,
					inventory,
					selection: selected,
					outcome: {
						kind: 'completed' as const,
						summary: {
							inspectedGroups: inventory.groups.length,
							selectedGroups: 0,
							skippedLiveGroups: inventory.totals.liveGroups,
							containersRemoved: 0,
							networksRemoved: 0,
							networksSkipped: 0,
							volumesRemoved: 0,
							imagesRemoved: 0,
						},
					},
				},
				humanLines: ['prune: no idle resource groups selected'],
			});
			return { exitCode: 0 } as CommandResult;
		}

		const outcome = yield* deps
			.prune({
				groupKeys: selected.groupKeys,
				resources: selected.resources,
				dryRun: ctx.flags.dryRun,
			})
			.pipe(Effect.catch(mapUnknownPruneError));

		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'prune',
			elapsedMs: Date.now() - started,
			dryRun: ctx.flags.dryRun,
			data: {
				mode: options.mode,
				dryRun: ctx.flags.dryRun,
				inventory,
				selection: selected,
				outcome,
			},
			humanLines: [completedLine(outcome.summary, ctx.flags.dryRun)],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.prune'));
