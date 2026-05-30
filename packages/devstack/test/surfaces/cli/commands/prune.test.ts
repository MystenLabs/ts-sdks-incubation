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
					sharedKind: 'router',
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
					sharedKind: 'router',
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
					sharedKind: 'per-app-shared',
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

		expect(defaultPruneSelection(inventory)).toEqual([
			'devstack-router/devstack-router-deadbeef',
			'private-content/_per-app_',
		]);
	});

	it('keeps a _per-app_ shared group pinned while a non-shared sibling under the same app is live', () => {
		const inventory: PruneInventory = {
			groups: [
				{
					key: 'my-app/main',
					app: 'my-app',
					stack: 'main',
					live: true,
					livePids: [12345],
					shared: false,
					sharedKind: null,
					autoPrunable: false,
					containers: 2,
					runningContainers: 2,
					networks: 1,
					volumes: 0,
					images: 0,
				},
				{
					key: 'my-app/_per-app_',
					app: 'my-app',
					stack: '_per-app_',
					live: false,
					livePids: [],
					shared: true,
					sharedKind: 'per-app-shared',
					autoPrunable: false,
					containers: 1,
					runningContainers: 0,
					networks: 0,
					volumes: 0,
					images: 0,
				},
			],
			totals: {
				groups: 2,
				liveGroups: 1,
				sharedGroups: 1,
				containers: 3,
				runningContainers: 2,
				networks: 1,
				volumes: 0,
				images: 0,
			},
		};
		expect(defaultPruneSelection(inventory)).toEqual([]);
	});

	it('auto-includes a _per-app_ shared group once all non-shared siblings are idle', () => {
		const inventory: PruneInventory = {
			groups: [
				{
					key: 'my-app/main',
					app: 'my-app',
					stack: 'main',
					live: false,
					livePids: [],
					shared: false,
					sharedKind: null,
					autoPrunable: false,
					containers: 2,
					runningContainers: 0,
					networks: 1,
					volumes: 0,
					images: 0,
				},
				{
					key: 'my-app/_per-app_',
					app: 'my-app',
					stack: '_per-app_',
					live: false,
					livePids: [],
					shared: true,
					sharedKind: 'per-app-shared',
					autoPrunable: false,
					containers: 1,
					runningContainers: 0,
					networks: 0,
					volumes: 0,
					images: 0,
				},
			],
			totals: {
				groups: 2,
				liveGroups: 0,
				sharedGroups: 1,
				containers: 3,
				runningContainers: 0,
				networks: 1,
				volumes: 0,
				images: 0,
			},
		};
		expect(defaultPruneSelection(inventory)).toEqual(['my-app/main', 'my-app/_per-app_']);
	});
});
