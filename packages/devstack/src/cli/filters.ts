// Action filters consumed by `runOneShot`. Each filter returns `true` for
// actions that should run against the resolved target, `false` for ones the
// cycle drops before the topo walk.
//
// `deployFilter` (devstack deploy) and `applyFilter` (devstack apply) differ
// on live nets: deploy keeps Build, apply drops it. `applyTestSetupFilter`
// is for Playwright globalSetup — runs Service (containers detach) but
// skips HostProcess (wallet-server / vite die when the test process exits).
// `emitOnlyFilter` runs only Emit actions.

import { seedRunsOn } from '../actions/seed.js';
import type { Action, ActionFilter, ResolvedTarget, SeedAction } from '../core/types.js';

/** Network allow-list filter. Actions can declare `networks: Network[]`
 *  to restrict where they run (e.g. `['localnet']` for accounts.fund's
 *  faucet flow). Actions without `networks` run on every target. */
function passesNetwork(action: Action, target: ResolvedTarget): boolean {
	const networks = action.networks;
	if (networks === undefined) return true;
	return networks.includes(target.network);
}

export const deployFilter: ActionFilter = (action, target) => {
	if (!passesNetwork(action, target)) return false;
	switch (action.type) {
		case 'Service':
		case 'HostProcess':
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
	if (!passesNetwork(action, target)) return false;
	if (target.network === 'localnet') {
		if (action.type === 'Seed') return seedRunsOn(action as SeedAction, target.network);
		return true;
	}
	switch (action.type) {
		case 'Service':
		case 'HostProcess':
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

export const applyTestSetupFilter: ActionFilter = (action, target) => {
	if (action.type === 'HostProcess') return false;
	return applyFilter(action, target);
};

export const emitOnlyFilter: ActionFilter = (action) => action.type === 'Emit';
