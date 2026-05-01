// `createDevstackDappKit({ defaultNetwork, ... })` — replaces the
// per-app `dapp-kit.ts` boilerplate (createDAppKit + dev-wallet
// initializer + manifest-derived RPC URL).
//
// Synchronous. Peer deps `@mysten/dapp-kit-core` + `@mysten/sui/grpc`
// are required at runtime. Wallet initializers are constructed by the
// caller (typically `devWalletInitializer` from
// `@mysten-incubation/dev-wallet`, configured with a
// `DevstackSignerAdapter`) and passed in via `walletInitializers`. The
// helper itself stays neutral about *how* signing is wired so apps can
// mix in custom adapters or skip the in-app wallet entirely.

import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import type { Network } from '../core/types.js';

export interface CreateDevstackDappKitOptions {
	defaultNetwork?: Network;
	additionalNetworks?: Network[];
	networks?: Partial<Record<Network, string>>;
	localnetRpcUrl?: string;
	/** Wallet initializers passed straight through to dapp-kit. The
	 * idiomatic devstack flow: build a `DevstackSignerAdapter` from the
	 * manifest's `wallet-server` service entry and wrap it with
	 * `devWalletInitializer({ adapters: [adapter], panels: devstackPanels(), mountUI: true })`. */
	walletInitializers?: unknown[];
	enableBurnerWallet?: boolean;
	/** Escape hatch — receives the constructed dapp-kit config and returns
	 * a (possibly modified) replacement. Use to inject extra wallet
	 * initializers, swap clients, etc. */
	extend?: (config: unknown) => unknown;
}

interface DevstackDappKit {
	dAppKit: ReturnType<typeof createDAppKit>;
}

export function createDevstackDappKit(opts: CreateDevstackDappKitOptions): DevstackDappKit {
	const defaultNetwork = opts.defaultNetwork ?? 'localnet';
	const networkList: Network[] = Array.from(
		new Set<Network>([defaultNetwork, ...(opts.additionalNetworks ?? [])]),
	);

	type DappKitConfig = Parameters<typeof createDAppKit>[0];
	const config = {
		networks: networkList,
		defaultNetwork,
		createClient: (network: Network) => {
			const url =
				opts.networks?.[network] ?? (network === 'localnet' ? opts.localnetRpcUrl : undefined);
			if (url === undefined) {
				throw new Error(
					`createDevstackDappKit: no RPC URL for network '${network}'. Pass via { networks: { ${network}: '...' } } or { localnetRpcUrl }.`,
				);
			}
			return new SuiGrpcClient({ network, baseUrl: url });
		},
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
		walletInitializers: opts.walletInitializers ?? [],
	} as unknown as DappKitConfig;

	const finalConfig = (opts.extend !== undefined ? opts.extend(config) : config) as DappKitConfig;
	const dAppKit = createDAppKit(finalConfig);
	const slot = globalThis as { __devstackDAppKit__?: unknown };
	if (slot.__devstackDAppKit__ !== undefined && slot.__devstackDAppKit__ !== dAppKit) {
		// Two apps in the same realm (micro-frontend, Storybook host, dev
		// HMR hot-reload that didn't tear down) silently overwriting each
		// other's dAppKit makes `useDevstackSignAndExecute` sign with the
		// wrong wallet. Warn loudly so the user catches it.
		// eslint-disable-next-line no-console
		console.warn(
			'[createDevstackDappKit] Overwriting an existing globalThis.__devstackDAppKit__. ' +
				'If you are running two devstack apps in the same window, useDevstackSignAndExecute ' +
				'will resolve the most-recently-created instance — be careful which one is active.',
		);
	}
	slot.__devstackDAppKit__ = dAppKit;
	return { dAppKit };
}
