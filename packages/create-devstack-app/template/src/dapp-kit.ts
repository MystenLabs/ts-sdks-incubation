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
 * MVR override map so the generated Move bindings resolve by their named
 * placeholder (`@local/<name>`) against the active network's deployed id.
 * The codegen emits each binding's `package` default as `@local/<name>`
 * and mirrors that string in `config.packages.<name>.mvr`; here we point
 * each one at `byNetwork[config.network]` so no real MVR registry is hit.
 * This is the sanctioned place to read `config` — app code resolves
 * packages by name and never touches `config.packages.*.packageId`.
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
