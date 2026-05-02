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

// Expose the kit for the playwright `connectAs` helper to drive
// account switching from page.evaluate(). Useful only in dev/e2e —
// no security concern beyond what the burner-wallet dev flow already
// surfaces.
(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;
