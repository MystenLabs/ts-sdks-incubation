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
					containers: 1,
					runningContainers: 1,
					networks: 1,
					volumes: 0,
					images: 0,
				},
			],
			totals: {
				groups: 2,
				liveGroups: 1,
				sharedGroups: 2,
				containers: 2,
				runningContainers: 1,
				networks: 2,
				volumes: 0,
				images: 0,
			},
		};

		expect(defaultPruneSelection(inventory)).toEqual(['devstack-router/devstack-router-deadbeef']);
	});
});
