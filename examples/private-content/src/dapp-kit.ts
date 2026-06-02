// User-owned dapp-kit wiring (prod-safe).
//
// dev/prod split:
//   - The browser RPC + active network come from the generated runtime
//     config (`@generated/config.js`) — safe in every build.
//   - The devstack dev wallet (and the `@devstack-dev/*` modules it
//     reads) only exist in a `devstack apply`-d local tree. They are
//     pulled in via a DYNAMIC import that is gated on `import.meta.env.DEV`,
//     so a production `vite build` never references them and `tsc -b`
//     succeeds even when `@devstack-dev/*` is absent.
//   - The playwright `connectAs` slot (`globalThis.__devstackDAppKit__`)
//     and the dev-only `accounts` map live in `./dapp-kit.dev.ts`, which
//     is imported through the same DEV-gated dynamic path.

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

/**
 * Local dev-wallet initializer wrapper. Construction stays synchronous:
 * the kit calls `initialize()` itself, and only THEN do we reach for the
 * gitignored `@devstack-dev/*` modules — behind a dynamic import that
 * Vite tree-shakes out of any non-DEV build. The structural return type
 * matches `createDAppKit`'s `walletInitializers` element so no value from
 * `@mysten-incubation/dev-wallet` is referenced at module top level.
 */
function devstackWalletInitializer(): {
	id: string;
	initialize(input: {
		networks: readonly string[];
		getClient: (network?: string) => import('@mysten/sui/client').ClientWithCoreApi;
	}): Promise<{ unregister: () => void }>;
} {
	return {
		id: 'devstack-dev-wallet',
		async initialize(input) {
			const { createDevWalletInitializer } = await import('./dapp-kit.dev.js');
			const initializer = await createDevWalletInitializer();
			return initializer.initialize(input);
		},
	};
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
	// In prod, no dev initializer — standard wallet-standard wallets
	// register themselves. In DEV, the wrapper above lazily wires the
	// devstack dev wallet + the playwright connectAs slot.
	walletInitializers: import.meta.env.DEV ? [devstackWalletInitializer()] : [],
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
