// Vanilla `createDAppKit` setup; localnet-specific bits come from
// `localnetDappKitConfig(manifest)`. On testnet/mainnet this file's
// shape stays identical — only the spread is different (or absent).

import { createDAppKit } from '@mysten/dapp-kit-core';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';
import { manifest } from 'virtual:devstack-manifest';

configureDevstackPanels(manifest);

const devstackAdapter = createDevstackAdapterFromManifest(manifest);

export const dAppKit = createDAppKit({
	...localnetDappKitConfig(manifest),
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
