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

const deepbookNetwork = 'localnet' as const;

/**
 * MVR override map for the local stack: maps each generated package's MVR
 * name (e.g. `@local/demo-coins`) to its published on-chain id for the active
 * generated network. The generated Move bindings default their `package` to
 * the `@local/<name>` MVR name, so wiring these overrides into the client lets
 * every binding call resolve to the right published package without app code
 * ever string-concatenating a package id.
 */
function mvrOverrides(): Record<string, string> {
	return Object.fromEntries(
		Object.values(config.packages)
			.map((p) => [p.mvr, p.byNetwork[config.network]] as const)
			.filter(([, id]) => Boolean(id)),
	);
}

export const dAppKit = createDAppKit({
	networks: [deepbookNetwork],
	defaultNetwork: deepbookNetwork,
	autoConnect: import.meta.env.DEV,
	createClient() {
		return new SuiGrpcClient({
			network: deepbookNetwork,
			baseUrl: config.networks[config.network].rpc,
			mvr: { overrides: { packages: mvrOverrides() } },
		});
	},
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
