import { describe, expect, it } from '@effect/vitest';

import {
	defaultPruneSelection,
	type PruneInventory,
} from '../../../../src/surfaces/cli/commands/prune.ts';

describe('prune selection', () => {
	it('selects idle shared router groups so stale router containers are cleaned', () => {
		const inventory: PruneInventory = {
			groups: [
				{
					key: 'devstack-router/devstack-router-deadbeef',
					app: 'devstack-router',
					stack: 'devstack-router-deadbeef',
					live: false,
					livePids: [],
					shared: true,
					autoPrunable: true,
					containers: 1,
					runningContainers: 0,
					networks: 1,
					volumes: 0,
					images: 0,
				},
				{
					key: 'devstack-router/devstack-router-live',
					app: 'devstack-router',
					stack: 'devstack-router-live',
					live: true,
					livePids: [],
					shared: true,
					autoPrunable: true,
					containers: 1,
					runningContainers: 1,
					networks: 1,
					volumes: 0,
					images: 0,
				},
				{
					key: 'private-content/_per-app_',
					app: 'private-content',
					stack: '_per-app_',
					live: false,
					livePids: [],
					shared: true,
					autoPrunable: false,
					containers: 1,
					runningContainers: 0,
					networks: 1,
					volumes: 0,
					images: 0,
				},
			],
			totals: {
				groups: 3,
				liveGroups: 1,
				sharedGroups: 3,
				containers: 3,
				runningContainers: 1,
				networks: 3,
				volumes: 0,
				images: 0,
			},
		};

		expect(defaultPruneSelection(inventory)).toEqual(['devstack-router/devstack-router-deadbeef']);
	});
});
