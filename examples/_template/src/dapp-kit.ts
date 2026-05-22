// User-owned dapp-kit wiring. Spreads the generated devstack config
// (RPC URL + MVR overrides + burner-wallet adapter) into
// `createDAppKit`. Add app-specific overrides on top of the spread.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { dappKitConfig } from './generated/dapp-kit/config.js';
import { suiNetwork } from './generated/sui/network.js';

const devstackNetwork = 'localnet' as const;

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
		}),
	],
});

// Expose the kit on globalThis so the playwright `connectAs` helper
// can drive account switching from `page.evaluate(...)`. Strip this
// behind an env guard in a production build.
(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
