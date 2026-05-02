// Action filters consumed by `runOneShot`. Each filter returns `true` for
// actions that should run against the resolved target, `false` for ones
// the cycle drops before the topo walk.
//
// Behavior matrix:
//
//                  | localnet | live net (testnet/mainnet)
//   -------------- | -------- | ---------------------------
//   deployFilter   | run all  | run Build/Publish/Register/Emit + gated Seed; skip Service
//   applyFilter    | run all  | run Publish/Register/Emit + gated Seed; skip Service+Build
//   emitOnlyFilter | Emit only| Emit only
//
// `deployFilter` preserves today's `runOneShot` behavior verbatim — it
// keeps Build on live nets even though Build is typically a docker-image
// build that doesn't make sense remotely. The plan's `applyFilter` is the
// tighter variant and is the right default for `devstack apply` (C2).
// The looser `deployFilter` stays the implicit default for `devstack
// deploy` so the C1 extraction is a true refactor with no behavior
// change for the live-net deploy path.

import { seedRunsOn } from '../actions/seed.js';
import type { ActionFilter, SeedAction } from '../core/types.js';

export const deployFilter: ActionFilter = (action, target) => {
	switch (action.type) {
		case 'Service':
			return false;
		case 'Seed':
			return seedRunsOn(action as SeedAction, target.network);
		case 'Build':
		case 'Publish':
		case 'Register':
		case 'Emit':
		case 'Verify':
			return true;
	}
};

export const applyFilter: ActionFilter = (action, target) => {
	if (target.network === 'localnet') {
		if (action.type === 'Seed') return seedRunsOn(action as SeedAction, target.network);
		return true;
	}
	switch (action.type) {
		case 'Service':
		case 'Build':
			return false;
		case 'Seed':
			return seedRunsOn(action as SeedAction, target.network);
		case 'Publish':
		case 'Register':
		case 'Emit':
		case 'Verify':
			return true;
	}
};

export const emitOnlyFilter: ActionFilter = (action) => action.type === 'Emit';
