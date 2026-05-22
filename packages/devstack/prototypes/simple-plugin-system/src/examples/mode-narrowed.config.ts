import { defineModeNamespace, defineNetwork } from '../core.ts';
import { defineDevstackWith, hostService } from '../builtins.ts';

const serviceFor = defineModeNamespace({
	local: {
		sidecar: () =>
			hostService({
				name: 'local-indexer',
				command: 'pnpm indexer:local',
				port: 5180,
			}),
	},
	fork: {
		proxy: () =>
			hostService({
				name: 'fork-indexer-proxy',
				command: 'pnpm indexer:fork',
				port: 5181,
			}),
	},
});

const localNetwork = defineNetwork({ mode: 'local', name: 'localnet' });

export const modeNarrowedStack = defineDevstackWith(
	{
		network: localNetwork,
		stackName: 'mode-narrowed',
	},
	({ network }) => {
		const sidecar = serviceFor.for(network).sidecar();

		if (false) {
			// @ts-expect-error fork-only factories are unavailable on a local network
			serviceFor.for(network).proxy();
		}

		return [sidecar];
	},
);
