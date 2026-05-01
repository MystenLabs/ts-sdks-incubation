// `createDevstackDappKit({ defaultNetwork, ... })` — replaces the
// per-app `dapp-kit.ts` boilerplate (createDAppKit + dev wallet
// initializer + manifest-derived RPC URL).
//
// Synchronous. Peer deps `@mysten/dapp-kit-core` + `@mysten/sui/grpc`
// are required at runtime. The dev-wallet initializer is plumbed via an
// explicit `walletInitializerFactory` param — apps that want it import
// `createDevWalletInitializer` from `@mysten-incubation/devstack-wallet`
// themselves and pass it in. This keeps devstack from carrying a
// magic-resolved peer dep that bundlers can't statically see.

import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import type { Network } from '../core/types.js';

export interface DevKey {
	label: string;
	secretKey: string;
}

/** Factory provided by `@mysten-incubation/devstack-wallet`. Re-typed
 * loosely to avoid a static dep on the package — apps pass the function
 * in via `walletInitializerFactory`. The wallets / chain shapes follow
 * devstack-wallet's narrower types at runtime. */
export type DevWalletInitializerFactory = (args: {
	wallets: ReadonlyArray<{ label: string; secretKey: string }>;
	// biome-ignore lint/suspicious/noExplicitAny: opaque to avoid a static dep on devstack-wallet
	chain?: any;
}) => unknown;

export interface CreateDevstackDappKitOptions {
	defaultNetwork?: Network;
	additionalNetworks?: Network[];
	networks?: Partial<Record<Network, string>>;
	localnetRpcUrl?: string;
	devKeys?: ReadonlyArray<DevKey>;
	/**
	 * Pass `createDevWalletInitializer` from
	 * `@mysten-incubation/devstack-wallet` to wire `devKeys` into
	 * dapp-kit as a registered wallet. Omit to skip dev-wallet
	 * registration (burner wallet still works).
	 */
	walletInitializerFactory?: DevWalletInitializerFactory;
	enableBurnerWallet?: boolean;
	/** Escape hatch — receives the constructed dapp-kit config and returns
	 * a (possibly modified) replacement. Use to inject extra wallet
	 * initializers, swap clients, etc. The shape is dapp-kit's
	 * `CreateDAppKitOptions`; we keep it `unknown` here to avoid pinning
	 * apps to a specific dapp-kit version's type surface. */
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

	const walletInitializers: unknown[] = [];
	const devKeys = opts.devKeys ?? [];
	if (devKeys.length > 0) {
		if (opts.walletInitializerFactory === undefined) {
			throw new Error(
				'createDevstackDappKit: `devKeys` were provided but no `walletInitializerFactory`. ' +
					'Pass `createDevWalletInitializer` from `@mysten-incubation/devstack-wallet` so the ' +
					'seeded keypairs register as a usable wallet — without it, the panel falls back to ' +
					"the burner wallet and your seeded `alice`/`bob`/etc. won't appear.",
			);
		}
		walletInitializers.push(
			opts.walletInitializerFactory({
				wallets: devKeys.map((k) => ({ label: k.label, secretKey: k.secretKey })),
				chain: `sui:${defaultNetwork}`,
			}),
		);
	}

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
		walletInitializers,
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
