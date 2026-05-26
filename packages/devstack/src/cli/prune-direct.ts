// L4-adjacent CLI infrastructure for `devstack prune`.
//
// Per STYLE_GUIDE §7: `cli/*.ts` modules sit alongside the bin entry
// (`cli/main.ts`) and may import L3 orchestrator/substrate barrels —
// they are NOT L4 surfaces proper. The actual cross-stack Docker
// orchestration lives at `orchestrators/lifecycle-prune/`; this file
// is the deps-builder the bin entry hands to the `prune` verb runner.

import { Effect } from 'effect';

import {
	collectLifecyclePruneInventory,
	runLifecyclePrune,
	type LifecyclePruneGroup,
	type LifecyclePruneInventory,
	type LifecyclePruneOptions,
} from '../orchestrators/lifecycle-prune/index.ts';
import {
	summarizePruneGroups,
	type PruneDeps,
	type PruneGroup,
	type PruneInventory,
	type PruneOutcome,
	type PruneSelection,
} from '../surfaces/cli/commands/index.ts';
import { selectPruneTargets } from '../surfaces/cli/commands/prune-picker-entry.ts';

const adaptGroup = (group: LifecyclePruneGroup): PruneGroup => ({
	key: group.key,
	app: group.app,
	stack: group.stack,
	live: group.live,
	livePids: group.livePids,
	shared: group.shared,
	autoPrunable: group.autoPrunable,
	containers: group.containers,
	runningContainers: group.runningContainers,
	networks: group.networks,
	volumes: group.volumes,
	images: group.images,
});

const adaptInventory = (inventory: LifecyclePruneInventory): PruneInventory => {
	const groups = inventory.groups.map(adaptGroup);
	return { groups, totals: summarizePruneGroups(groups) };
};

const collectInventory = (
	options: LifecyclePruneOptions,
): Effect.Effect<PruneInventory, unknown> =>
	collectLifecyclePruneInventory(options).pipe(Effect.map(adaptInventory));

const pruneSelection = (
	options: LifecyclePruneOptions,
	selection: PruneSelection,
): Effect.Effect<PruneOutcome, unknown> =>
	runLifecyclePrune(options, {
		groupKeys: selection.groupKeys,
		resources: selection.resources,
		dryRun: selection.dryRun,
	}).pipe(Effect.map((summary) => ({ kind: 'completed' as const, summary })));

export const makeDirectPruneDeps = (options: LifecyclePruneOptions): PruneDeps => ({
	inventory: () => collectInventory(options),
	prune: (selection) => pruneSelection(options, selection),
	select: (inventory, resources) => selectPruneTargets(inventory, resources),
});
