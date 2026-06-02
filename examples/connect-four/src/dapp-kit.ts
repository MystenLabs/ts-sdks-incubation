// User-owned dapp-kit wiring (prod-safe).
//
// The browser RPC + active network come from the generated runtime config
// (`@generated/config.js`) — safe in every build. The dev wallet is no
// longer wired here: in DEV the devstack Vite plugin injects + registers
// the devstack dev wallet on the page via wallet-standard, so dApp Kit
// auto-discovers it (and the plugin also populates the Playwright
// `connectAs` slot, `globalThis.__devstackDAppKit__`). In production the
// page carries no dev wallet and standard wallets register themselves.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from '@generated/config.js';

const devstackNetwork = 'localnet' as const;

/**
 * Build the MVR override map the grpc client uses to resolve the named
 * Move packages (`@local/connect-four`) the generated bindings emit as
 * their default `package`. Each entry maps the package's MVR name to its
 * on-chain id for the active generated network. `config` is sanctioned in
 * this file only; app code consumes the bindings' MVR defaults instead.
 */
function mvrOverrides(): Record<string, string> {
	return Object.fromEntries(
		Object.values(config.packages)
			.map((p) => [p.mvr, p.byNetwork[config.network]] as const)
			.filter(([, id]) => Boolean(id)),
	);
}

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	autoConnect: import.meta.env.DEV,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
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
