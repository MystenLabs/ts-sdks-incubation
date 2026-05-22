import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';
import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { dappKitConfig } from './generated/dapp-kit/config.js';
import { suiNetwork } from './generated/sui/network.js';

const devstackNetwork = dappKitConfig.chain;

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
			baseUrl: suiNetwork.rpcUrl,
		});
	},
	walletInitializers: [
		devWalletInitializer({
			adapters: [
				new DevstackSignerAdapter({
					serverOrigin: dappKitConfig.walletUrl,
					token: parseDevstackToken(dappKitConfig.pairUrl),
					name: 'Devstack',
				}),
			],
			autoConnect: true,
			createInitialAccount: false,
			mountUI: true,
		}),
	],
});

(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
