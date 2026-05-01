import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
import { createDevWalletInitializer } from '@mysten-incubation/devstack-wallet';
import { devKeys } from 'virtual:devstack-keys';

import { deployment } from './generated/deployment.js';

export const { dAppKit } = createDevstackDappKit({
	defaultNetwork: 'localnet',
	localnetRpcUrl: deployment.rpcUrl,
	devKeys,
	walletInitializerFactory: createDevWalletInitializer,
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
