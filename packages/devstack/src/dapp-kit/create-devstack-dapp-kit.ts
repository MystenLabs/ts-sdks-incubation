// One-line dapp-kit setup for devstack-backed apps. Replaces the
// byte-identical `dapp-kit.ts` boilerplate that used to live in every
// example.
//
// Apps now do (in `dapp-kit.ts` or inline in main.tsx):
//
// ```ts
// import { manifest } from './generated/manifest.js';
// import { createDevstackDappKit } from '@mysten-incubation/devstack/dapp-kit';
//
// export const { dAppKit } = await createDevstackDappKit({ manifest });
//
// declare module '@mysten/dapp-kit-react' {
//   interface Register {
//     dAppKit: typeof dAppKit;
//   }
// }
// ```
//
// Ships from the `/react` subpath alongside the other dapp-kit-coupled
// helpers; CLI / supervisor consumers don't pull this in. Pairs with
// the server-side `walletApp.create({...})` plugin in the main
// package — the import subpath disambiguates the role.

import type { DAppKit } from '@mysten/dapp-kit-core';
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import type { WalletPanelDescriptor } from '@mysten-incubation/dev-wallet';

// Inline the network string union to keep the public return type from
// dragging shape types through .d.ts paths.
type Network = 'localnet' | 'testnet' | 'mainnet';

interface ManifestShape {
	packages?: Array<{ name: string; packageId: string; mvrPlaceholder?: string }>;
	endpoints?: Array<{ name: string; url: string; pairUrl?: string }>;
}

export interface LocalnetMvrOverrides {
	packages: Record<string, string>;
}

/**
 * Build MVR-style package overrides from the devstack manifest.
 * Each package whose `mvrPlaceholder` was emitted by `publishMove`
 * becomes a `placeholder → packageId` entry. Spread into
 * `SuiGrpcClient`'s `mvr.overrides` so the SDK's `namedPackagesPlugin`
 * resolves placeholders to live `packageId`s at transaction-build time.
 *
 * `localnetDappKitConfig(manifest)` does this automatically — most
 * apps don't call it directly.
 */
export function localnetMvrOverrides(manifest: unknown): LocalnetMvrOverrides {
	const m = manifest as ManifestShape | undefined;
	const packages: Record<string, string> = {};
	for (const p of m?.packages ?? []) {
		if (p.mvrPlaceholder !== undefined) {
			packages[p.mvrPlaceholder] = p.packageId;
		}
	}
	return { packages };
}

export interface LocalnetDappKitConfig {
	defaultNetwork: 'localnet';
	networks: Network[];
	createClient: (network: Network) => SuiGrpcClient;
	enableBurnerWallet: boolean;
}

export interface LocalnetDappKitConfigOptions {
	/** Override the resolved RPC URL. Defaults to the manifest's
	 * `sui-rpc` endpoint. Use when the dev server proxies the RPC. */
	localnetRpcUrl?: string;
	/** Extra networks beyond `'localnet'`. */
	additionalNetworks?: Network[];
	/** Per-network RPC URLs for any `additionalNetworks`. */
	networks?: Partial<Record<Network, string>>;
	/** Pass-through to dapp-kit. Default true. */
	enableBurnerWallet?: boolean;
}

/**
 * Localnet-specific config inputs for `createDAppKit(...)`. Reads the
 * manifest to find the sui-rpc URL, then returns the
 * `defaultNetwork` / `networks` / `createClient` triple.
 *
 * Throws if the manifest doesn't carry a sui-rpc endpoint (the stack
 * hasn't reached the localnet bring-up step).
 */
export function localnetDappKitConfig(
	manifest: unknown,
	opts: LocalnetDappKitConfigOptions = {},
): LocalnetDappKitConfig {
	const m = manifest as ManifestShape | undefined;
	const endpoints = m?.endpoints ?? [];
	const localnetRpcUrl =
		opts.localnetRpcUrl ?? endpoints.find((e) => e.name === 'sui-rpc')?.url;
	if (localnetRpcUrl === undefined) {
		throw new Error(
			'localnetDappKitConfig: no localnetRpcUrl provided and no `sui-rpc` endpoint in manifest. ' +
				'Has `devstack up` reached the sui plugin?',
		);
	}
	const networks: Network[] = Array.from(
		new Set<Network>(['localnet', ...(opts.additionalNetworks ?? [])]),
	);
	const mvrOverrides = localnetMvrOverrides(manifest);
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
			const mvr =
				network === 'localnet' && Object.keys(mvrOverrides.packages).length > 0
					? { overrides: { packages: mvrOverrides.packages } }
					: undefined;
			return new SuiGrpcClient({ network, baseUrl: url, mvr });
		},
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
	};
}

export interface CreateDevstackDappKitOptions {
	manifest: unknown;
	/** Pass-through to dev-wallet. Default true. */
	autoConnect?: boolean;
	/** Default true — devstack auto-approves burner-wallet signing
	 * requests so e2e flows stay non-interactive. */
	autoApprove?: boolean;
	/** Default true. Set false for headless hosts (node-side rendering
	 * tests). When false, the panels module is NOT loaded — production
	 * bundles drop the panels code entirely. */
	mountUI?: boolean;
	/** Expose the constructed kit on `globalThis.__devstackDAppKit__` so
	 * the playwright `connectAs` helper can drive account switching from
	 * `page.evaluate(...)`. Defaults to true under Vite dev / preview /
	 * `process.env.PLAYWRIGHT === '1'`; false otherwise. */
	exposeForPlaywright?: boolean;
}

/** The dapp-kit type `createDevstackDappKit` returns. */
export type DevstackDappKit = DAppKit<('localnet' | 'testnet' | 'mainnet')[], SuiGrpcClient>;

function shouldExposeForPlaywright(): boolean {
	const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
	if (env?.DEV === true) return true;
	if (env?.MODE === 'preview') return true;
	if (typeof process !== 'undefined' && process.env?.PLAYWRIGHT === '1') return true;
	return false;
}

/**
 * Construct a dapp-kit instance wired up for devstack: localnet
 * network config, MVR overrides for `publishMove`-emitted placeholders,
 * the devstack burner-wallet adapter, and (optionally) the devstack
 * panels (Faucet, Packages, Network).
 *
 * **Localnet only.** This factory throws when the manifest doesn't
 * carry a sui-rpc endpoint. For production deploys, swap
 * `dapp-kit.ts` for a hand-written setup that calls `createDAppKit`
 * directly with a real wallet adapter (Slush, Suiet, etc.) and only
 * the live-net manifest fields the app actually needs.
 *
 * The function is `async` so it can lazy-load the panels module under
 * `mountUI: true`. Bundlers tree-shake the panels import out of
 * production builds when `mountUI: false`.
 */
export async function createDevstackDappKit(
	opts: CreateDevstackDappKitOptions,
): Promise<{ dAppKit: DevstackDappKit }> {
	const mountUI = opts.mountUI ?? true;
	let panels: WalletPanelDescriptor[] = [];
	if (mountUI) {
		try {
			const panelsModule = await import('@mysten-incubation/devstack-wallet-panels');
			panelsModule.configureDevstackPanels(opts.manifest);
			panels = panelsModule.devstackPanels();
		} catch (err) {
			console.warn(
				'[createDevstackDappKit] failed to load @mysten-incubation/devstack-wallet-panels; ' +
					'rendering without dev panels (dAppKit otherwise unaffected).',
				err,
			);
		}
	}
	const devstackAdapter = createDevstackAdapterFromManifest(
		opts.manifest as Parameters<typeof createDevstackAdapterFromManifest>[0],
	);
	const dAppKit = createDAppKit({
		...localnetDappKitConfig(opts.manifest),
		walletInitializers: [
			devWalletInitializer({
				adapters: devstackAdapter ? [devstackAdapter] : [],
				panels,
				autoConnect: opts.autoConnect ?? true,
				autoApprove: opts.autoApprove ?? true,
				mountUI,
			}),
		],
	});
	const exposeForPlaywright = opts.exposeForPlaywright ?? shouldExposeForPlaywright();
	if (exposeForPlaywright) {
		const slot = globalThis as { __devstackDAppKit__?: typeof dAppKit };
		slot.__devstackDAppKit__ = dAppKit;
		const meta = import.meta as { hot?: { dispose: (cb: () => void) => void } };
		meta.hot?.dispose(() => {
			if (slot.__devstackDAppKit__ === dAppKit) {
				slot.__devstackDAppKit__ = undefined;
			}
		});
	}
	return { dAppKit };
}
