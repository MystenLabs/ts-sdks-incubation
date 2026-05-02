// dapp-kit setup helpers for devstack apps.
//
// `localnetDappKitConfig(manifest, opts)` returns the config inputs
// dapp-kit needs on localnet — the network list + a `createClient`
// factory that points at the manifest's sui-rpc service URL. Apps
// pass it into a vanilla `createDAppKit({...})`:
//
//     import { createDAppKit } from '@mysten/dapp-kit-core';
//     import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
//     import { manifest } from 'virtual:devstack-manifest';
//
//     const { dAppKit } = createDAppKit({
//       ...localnetDappKitConfig(manifest),
//       walletInitializers: [devWalletInitializer({ ... })],
//     });
//
// The same call site on testnet/mainnet drops the spread and passes
// the network/client config directly. Keeps app code structurally
// identical between local and prod.
//
// `createDevstackDappKit` (kept for back-compat) is a thin convenience
// that calls `createDAppKit` for you. It's @deprecated; new code uses
// the spread shape above.

import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// Inline the network string union to keep the public return type from
// referencing devstack's `core/types.ts` — TypeScript otherwise emits
// the path into example apps' .d.ts (TS2742) on portability checks.
type Network = 'localnet' | 'testnet' | 'mainnet';

interface ManifestServicesShape {
	registry?: { services?: Array<{ name: string; url: string }> };
}

export interface LocalnetDappKitConfig {
	defaultNetwork: 'localnet';
	networks: Network[];
	createClient: (network: Network) => SuiGrpcClient;
	enableBurnerWallet: boolean;
}

export interface LocalnetDappKitConfigOptions {
	/** Override the resolved RPC URL. Defaults to the manifest's
	 * `sui-rpc` service entry. Use when the dev server proxies the RPC
	 * through a different port (e.g. tunneling). */
	localnetRpcUrl?: string;
	/** Extra networks to register beyond `'localnet'`. Useful when
	 * a single dev session also targets a public testnet. */
	additionalNetworks?: Network[];
	/** Per-network RPC URLs for any `additionalNetworks` declared.
	 * `localnet` falls back to the manifest. */
	networks?: Partial<Record<Network, string>>;
	/** Pass-through to dapp-kit. Default true. */
	enableBurnerWallet?: boolean;
}

/**
 * Localnet-specific config inputs for `createDAppKit(...)`. Reads the
 * manifest to find the sui-rpc URL, then returns the
 * `defaultNetwork` / `networks` / `createClient` triple.
 *
 * Throws if the manifest doesn't carry a sui-rpc service yet (the
 * stack hasn't reached the localnet bring-up step). Apps that want
 * pre-deploy graceful behavior should branch on `manifest.app !== ''`
 * before constructing.
 */
export function localnetDappKitConfig(
	manifest: unknown,
	opts: LocalnetDappKitConfigOptions = {},
): LocalnetDappKitConfig {
	const m = manifest as ManifestServicesShape | undefined;
	const services = m?.registry?.services ?? [];
	const localnetRpcUrl =
		opts.localnetRpcUrl ?? services.find((s) => s.name === 'sui-rpc')?.url;
	if (localnetRpcUrl === undefined) {
		throw new Error(
			'localnetDappKitConfig: no localnetRpcUrl provided and no `sui-rpc` service in manifest. Has `pnpm localnet:up` reached the sui plugin?',
		);
	}
	const networks: Network[] = Array.from(
		new Set<Network>(['localnet', ...(opts.additionalNetworks ?? [])]),
	);
	return {
		defaultNetwork: 'localnet',
		networks,
		createClient: (network: Network) => {
			const url = network === 'localnet' ? localnetRpcUrl : opts.networks?.[network];
			if (url === undefined) {
				throw new Error(
					`localnetDappKitConfig: no RPC URL for network '${network}'. Pass via { networks: { ${network}: '...' } }.`,
				);
			}
			return new SuiGrpcClient({ network, baseUrl: url });
		},
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
	};
}

export interface CreateDevstackDappKitOptions {
	defaultNetwork?: Network;
	additionalNetworks?: Network[];
	networks?: Partial<Record<Network, string>>;
	localnetRpcUrl?: string;
	walletInitializers?: unknown[];
	enableBurnerWallet?: boolean;
	/** Escape hatch — receives the constructed dapp-kit config and
	 * returns a (possibly modified) replacement. */
	extend?: (config: unknown) => unknown;
}

interface DevstackDappKit {
	dAppKit: ReturnType<typeof createDAppKit>;
}

/**
 * Convenience that wires `localnetDappKitConfig(...)` into
 * `createDAppKit(...)` for the common single-network case.
 *
 * @deprecated Prefer the explicit shape so the call site stays
 * identical between localnet and production:
 *
 *     import { createDAppKit } from '@mysten/dapp-kit-core';
 *     import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
 *
 *     const { dAppKit } = createDAppKit({
 *       ...localnetDappKitConfig(manifest),
 *       walletInitializers: [...],
 *     });
 *
 * On mainnet, drop the spread and pass `defaultNetwork`/`networks`/
 * `createClient` directly. See `notes/react-api-investigation.md`.
 */
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
				opts.networks?.[network] ??
				(network === 'localnet' ? opts.localnetRpcUrl : undefined);
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
	// Legacy back-compat: also publish to `globalThis.__devstackDAppKit__`
	// so apps that haven't migrated to passing `dAppKit` through
	// `<DevstackProvider>` still get a working `useDevstackSignAndExecute`.
	// The hook prefers the context value; this slot is a fallback only.
	// Drop in the next major.
	(globalThis as { __devstackDAppKit__?: unknown }).__devstackDAppKit__ = dAppKit;
	return { dAppKit };
}
