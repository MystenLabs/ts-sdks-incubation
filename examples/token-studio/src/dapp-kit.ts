import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';
import { manifest } from 'virtual:devstack-manifest';

import { deployment } from './generated/deployment.js';

configureDevstackPanels(manifest);

const devstackAdapter = createDevstackAdapterFromManifest(manifest);

export const { dAppKit } = createDevstackDappKit({
	defaultNetwork: 'localnet',
	localnetRpcUrl: deployment.rpcUrl,
	walletInitializers: [
		devWalletInitializer({
			adapters: devstackAdapter ? [devstackAdapter] : [],
			panels: devstackPanels(),
			autoConnect: true,
			autoApprove: true,
			mountUI: true,
		}),
	],
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
