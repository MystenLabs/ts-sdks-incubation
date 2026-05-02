// dapp-kit setup helpers for devstack apps.
//
// `localnetDappKitConfig(manifest, opts)` returns the config inputs
// dapp-kit needs on localnet — the network list + a `createClient`
// factory that points at the manifest's sui-rpc service URL AND
// pre-loads MVR overrides so codegen-emitted `@local-pkg/<name>`
// placeholders resolve to live packageIds at tx-build time. Apps
// pass it into a vanilla `createDAppKit({...})`:
//
//     import { createDAppKit } from '@mysten/dapp-kit-core';
//     import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
//     import { manifest } from 'virtual:devstack-manifest';
//
//     const dAppKit = createDAppKit({
//       ...localnetDappKitConfig(manifest),
//       walletInitializers: [devWalletInitializer({ ... })],
//     });
//
// The same call site on testnet/mainnet drops the spread and passes
// the network/client config directly. Keeps app code structurally
// identical between local and prod.

import { SuiGrpcClient } from '@mysten/sui/grpc';

// Inline the network string union to keep the public return type from
// referencing devstack's `core/types.ts` — TypeScript otherwise emits
// the path into example apps' .d.ts (TS2742) on portability checks.
type Network = 'localnet' | 'testnet' | 'mainnet';

interface ManifestRegistryShape {
	registry?: {
		services?: Array<{ name: string; url: string }>;
		packages?: Array<{ name: string; packageId: string }>;
	};
}

export interface LocalnetMvrOverrides {
	packages: Record<string, string>;
}

/**
 * Default MVR-shape mapper. Move package names typically use
 * snake_case (`mock_usdc`); MVR app-name validation requires kebab
 * (`mock-usdc`). The default kebabizes and prefixes `@local/`.
 *
 * Mirrors the same default in the `codegen()` plugin's `mvrName`
 * option. Apps with a custom org override BOTH:
 *
 *     codegen({ mvrName: name => `@arena/${kebab(name)}` })
 *     localnetDappKitConfig(manifest, { mvrName: name => `@arena/${kebab(name)}` })
 */
export function defaultMvrName(pkgName: string): string {
	return `@local/${pkgName.replace(/_/g, '-')}`;
}

export interface LocalnetMvrOverridesOptions {
	/** Map a registry package name to its MVR-shape placeholder. Must
	 * agree with the matching option on the `codegen()` plugin so the
	 * codegen-emitted `tx.moveCall({ package: ... })` placeholder lines
	 * up with the override key. Defaults to {@link defaultMvrName}. */
	mvrName?: (pkgName: string) => string;
}

/**
 * Build MVR-style package overrides from the devstack manifest. Each
 * registry package becomes a `mvrName(pkgName) → packageId` entry.
 * Spread into `SuiGrpcClient`'s `mvr.overrides` so the SDK's
 * `namedPackagesPlugin` resolves codegen-emitted placeholders to live
 * `packageId`s at transaction build time.
 *
 *     new SuiGrpcClient({
 *       network, baseUrl,
 *       mvr: { overrides: localnetMvrOverrides(manifest) },
 *     })
 *
 * `localnetDappKitConfig(manifest)` does this automatically on the
 * localnet network — most apps just spread that helper and don't call
 * this directly.
 */
export function localnetMvrOverrides(
	manifest: unknown,
	opts: LocalnetMvrOverridesOptions = {},
): LocalnetMvrOverrides {
	const mvrName = opts.mvrName ?? defaultMvrName;
	const m = manifest as ManifestRegistryShape | undefined;
	const packages: Record<string, string> = {};
	for (const p of m?.registry?.packages ?? []) {
		packages[mvrName(p.name)] = p.packageId;
	}
	return { packages };
}

type ManifestServicesShape = ManifestRegistryShape;

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
	/** MVR-name mapper for the SuiClient's `mvr.overrides.packages`.
	 * Must match the `mvrName` option passed to the `codegen()` plugin
	 * so the codegen-emitted `@org/app-name` placeholders agree with
	 * the override keys. Defaults to {@link defaultMvrName}. */
	mvrName?: (pkgName: string) => string;
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
	const mvrOverrides = localnetMvrOverrides(manifest, { mvrName: opts.mvrName });
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
			// Apply MVR overrides only on localnet — live nets use real
			// MVR resolution from chain.
			const mvr =
				network === 'localnet' && Object.keys(mvrOverrides.packages).length > 0
					? { overrides: { packages: mvrOverrides.packages } }
					: undefined;
			return new SuiGrpcClient({ network, baseUrl: url, mvr });
		},
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
	};
}

