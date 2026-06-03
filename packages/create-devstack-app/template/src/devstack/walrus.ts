// Walrus plugin wiring (optional). Stands up a 1-node local Walrus cluster,
// mints its WAL coin, funds the demo account with WAL, and makes the host
// service wait for the cluster.

import { walCoin, walrus } from '@mysten-incubation/devstack';

import type { PluginContribution, PluginModule } from './contribution.js';

export const walrusModule: PluginModule = {
	id: 'walrus',
	setup(): PluginContribution {
		const walrusCluster = walrus({ local: { nodeCount: 1 } });
		const wal = walCoin(walrusCluster);
		return {
			fundingForAlice: [{ coin: wal, amount: 500_000_000n }],
			after: [walrusCluster],
		};
	},
};
