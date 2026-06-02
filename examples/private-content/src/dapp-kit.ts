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
 * Build the MVR name -> package-id override map the grpc client uses to
 * resolve binding-default package references (the vault bindings emit
 * `options.package ?? 'vault'`). Sourced from the generated config so the
 * app's Move calls never hard-code a deployed package id.
 */
function mvrOverrides(): Record<string, string> {
	return Object.fromEntries(
		Object.values(config.packages)
			.map((p) => [p.mvr, p.byNetwork[config.network]] as const)
			.filter(([, id]) => Boolean(id)),
	);
}

/**
 * The MVR-resolved vault package id for the active network. Used by the
 * Seal IBE callsites (`SealClient.encrypt` / `SessionKey.create`) and the
 * Cap-type query string — consumers that are NOT tx moveCalls and so are
 * not resolved by the grpc client's MVR overrides. `undefined` until the
 * stack is applied.
 */
export const vaultPackageId: string | undefined =
	config.packages.vault?.byNetwork[config.network];

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
