// Lazy seam for the ink/react-based prune-picker UI.
//
// `cli/prune-direct.ts` is on every `devstack` CLI invocation path, so
// the picker entry MUST NOT eagerly pull `ink` + `react` (~ several MB
// of cold-start cost). Mirrors the `surfaces/tui/index.ts:dynamic
// import('./mount-ink.tsx')` lazy-import pattern.

import { Effect } from 'effect';

import type {
	PruneInventory,
	PruneResourceScope,
	PruneTargetSelection,
} from './prune.ts';

export const selectPruneTargets = (
	inventory: PruneInventory,
	resources: PruneResourceScope,
): Effect.Effect<PruneTargetSelection> => {
	if (inventory.groups.length === 0) return Effect.succeed({ groupKeys: [], resources });
	return Effect.promise(() => import('./prune-picker.tsx')).pipe(
		Effect.flatMap((mod) => mod.selectPruneTargets(inventory, resources)),
	);
};
