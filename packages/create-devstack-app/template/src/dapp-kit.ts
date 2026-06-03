// User-owned dapp-kit wiring (prod-safe).
//
// The browser RPC + active network come from the generated runtime config
// (`@generated/config.js`) — safe in every build. The dev wallet is not
// wired here: in DEV the devstack Vite plugin injects the dev wallet on the
// page (dApp Kit auto-discovers it via wallet-standard); in production the
// page carries no dev wallet and standard wallets register themselves.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from '@generated/config.js';

const devstackNetwork = 'localnet' as const;

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	autoConnect: import.meta.env.DEV,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
			baseUrl: config.networks[config.network].rpc,
			// `config.mvrOverrides` is the codegen-emitted active-network
			// name→id map: each generated Move binding defaults its `package`
			// to `@local/<name>`, and this map points that name at the
			// deployed id so no real MVR registry is hit. App code resolves
			// packages by name and never touches `config.packages.*.packageId`.
			mvr: { overrides: { packages: config.mvrOverrides } },
		});
	},
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
