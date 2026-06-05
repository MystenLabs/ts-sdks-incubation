// DeepBook plugin wiring (optional). One-liner local DeX: synthesizes a
// publisher, publishes DeepBook + Pyth from the plugin's bundled assets, and
// seeds a default DEEP/SUI pool. The host service waits for it to be ready.

import { deepbook } from '@mysten-incubation/devstack';

import type { PluginContribution, PluginModule } from './contribution.js';

export const deepbookModule: PluginModule = {
	setup(): PluginContribution {
		const dex = deepbook();
		return { after: [dex] };
	},
};
