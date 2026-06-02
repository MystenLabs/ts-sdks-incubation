// User-owned dapp-kit wiring (prod-safe).
//
// The browser RPC + active network come from the generated runtime config
// (`@generated/config.js`) — safe in every build. The dev wallet is no
// longer wired here: in DEV the devstack Vite plugin injects + registers
// the devstack dev wallet on the page via wallet-standard, so dApp Kit
// auto-discovers it (and the plugin also populates the Playwright
// `connectAs` slot, `globalThis.__devstackDAppKit__`). The UI's
// account directory is read from the connected wallet via dApp Kit
// (`useCurrentWallet().accounts`, see `./lib/accounts.ts`). In
// production the page carries no dev wallet and standard wallets register
// themselves.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from '@generated/config.js';

const devstackNetwork = 'localnet' as const;

/**
 * MVR override map for the local stack: maps each generated package's MVR
 * name (e.g. `@local/managed_coin`) to its published on-chain id for the
 * active generated network. The generated Move bindings default their
 * `package` to the `@local/<name>` MVR name, so wiring these overrides into
 * the client lets every binding call resolve to the right published package
 * without app code ever string-concatenating a package id.
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
