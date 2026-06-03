// User-owned dapp-kit wiring (prod-safe).
//
// The browser RPC + active network come from the generated runtime config
// (`@generated/config.js`) — safe in every build. The dev wallet is not
// wired here: in DEV the devstack Vite plugin injects the dev wallet on the
// page (dApp Kit auto-discovers it via wallet-standard). The UI's account
// directory is read from the connected wallet via dApp Kit
// (`useCurrentWallet().accounts`). In production the page carries no dev
// wallet and standard wallets register themselves.

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
			// to the `@local/<name>` MVR name (e.g. `@local/managed_coin`), and
			// this map resolves it to the published id — so every binding call
			// resolves without app code ever string-concatenating a package id.
			mvr: { overrides: { packages: config.mvrOverrides } },
		});
	},
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
