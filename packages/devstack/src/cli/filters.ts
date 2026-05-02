// Action filters consumed by `runOneShot`. Each filter returns `true` for
// actions that should run against the resolved target, `false` for ones
// the cycle drops before the topo walk.
//
// Behavior matrix:
//
//                       | localnet                | live net (testnet/mainnet)
//   ------------------- | ----------------------- | ---------------------------
//   deployFilter        | run all                 | run Build/Publish/Register/Emit + gated Seed; skip Service+HostProcess
//   applyFilter         | run all                 | run Publish/Register/Emit + gated Seed; skip Service+Build+HostProcess
//   applyTestSetupFilter| run all EXCEPT HostProc | (not applicable — test setup is localnet-only)
//   emitOnlyFilter      | Emit only               | Emit only
//
// `deployFilter` preserves today's `runOneShot` behavior verbatim — it
// keeps Build on live nets even though Build is typically a docker-image
// build that doesn't make sense remotely. The plan's `applyFilter` is the
// tighter variant and is the right default for `devstack apply` (C2).
// The looser `deployFilter` stays the implicit default for `devstack
// deploy` so the C1 extraction is a true refactor with no behavior
// change for the live-net deploy path.
//
// `applyTestSetupFilter` is for Playwright globalSetup and equivalent
// test-bringup paths: bring the chain to known state (run Service so
// docker containers come up + detach), but DO NOT start in-process
// services that die when the test process exits (HostProcess —
// wallet-server, vite). The webServer's `pnpm dev` Supervisor owns
// HostProcess lifecycle from there, eliminating the documented two-
// supervisor token race in notes/architecture-review/23-playwright-integration.md.

import { seedRunsOn } from '../actions/seed.js';
import type { Action, ActionFilter, ResolvedTarget, SeedAction } from '../core/types.js';

/** Setup-action scope filter. App-level setup actions declared in
 *  `DevstackConfig.setup` carry an optional `scope` field; out-of-scope
 *  actions are dropped before the topo walk. Framework actions don't set
 *  `scope` so this returns true for them by default. */
function passesScope(action: Action, target: ResolvedTarget): boolean {
	const scope = action.scope ?? 'always';
	if (scope === 'always') return true;
	if (scope === 'localnet-only') return target.network === 'localnet';
	if (scope === 'test-only') {
		return target.network === 'localnet' && target.stack.startsWith('test');
	}
	return true;
}

export const deployFilter: ActionFilter = (action, target) => {
	if (!passesScope(action, target)) return false;
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
	if (!passesScope(action, target)) return false;
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
