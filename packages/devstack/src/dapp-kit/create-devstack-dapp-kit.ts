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
// The kit's network follows the manifest's `services.sui.network` field
// — which the supervisor populated from `--network` (or
// `DEVSTACK_NETWORK`) at boot. So `pnpm dev` on localnet produces a
// localnet kit; `devstack up --network testnet` produces a testnet
// kit. No per-network user wiring.
//
// Ships from the `/dapp-kit` subpath alongside the other dapp-kit-coupled
// helpers; CLI / supervisor consumers don't pull this in. Pairs with
// the server-side `walletApp(...)` primitive in the main package — the
// import subpath disambiguates the role.

import type { DAppKit } from '@mysten/dapp-kit-core';
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { fromManifest } from '../runtime/manifest-loader.js';

// Inline the network string union to keep the public return type from
// dragging shape types through .d.ts paths.
type Network = 'localnet' | 'testnet' | 'mainnet';

export interface DevstackMvrOverrides {
	packages: Record<string, string>;
}

/**
 * Build MVR-style package overrides from the devstack manifest.
 * Each package whose `mvrPlaceholder` was emitted by `publishMove`
 * becomes a `placeholder → packageId` entry. Spread into
 * `SuiGrpcClient`'s `mvr.overrides` so the SDK's `namedPackagesPlugin`
 * resolves placeholders to live `packageId`s at transaction-build time.
 *
 * Network-agnostic — the package ids come from whatever network the
 * supervisor published to, so the overrides are valid on localnet,
 * testnet, or mainnet alike.
 *
 * `createDappKitConfig(manifest)` does this automatically — most
 * apps don't call it directly.
 */
export function mvrOverridesFromManifest(manifest: unknown): DevstackMvrOverrides {
	const packages: Record<string, string> = {};
	if (manifest === null || manifest === undefined || typeof manifest !== 'object') {
		return { packages };
	}
	const v4 = fromManifest(manifest);
	for (const [, pkg] of Object.entries(v4.packages)) {
		if (pkg.mvr !== undefined) {
			packages[pkg.mvr] = pkg.id;
		}
	}
	return { packages };
}

export interface DevstackDappKitConfig {
	/** The network the manifest declares `services.sui` is running on.
	 *  This is whatever `--network` (or `DEVSTACK_NETWORK`) resolved to
	 *  on the supervisor side. */
	defaultNetwork: Network;
	/** A single-element list (just `defaultNetwork`). dapp-kit wants the
	 *  array shape, but the kit only knows about the one network the
	 *  manifest pinned. */
	networks: Network[];
	createClient: (network: Network) => SuiGrpcClient;
	enableBurnerWallet: boolean;
}

export interface DevstackDappKitConfigOptions {
	/** Override the resolved RPC URL. Defaults to the manifest's
	 *  `services.sui.rpc` endpoint. Use when the dev server proxies the
	 *  RPC. */
	rpcUrl?: string;
	/** Pass-through to dapp-kit. Default true. */
	enableBurnerWallet?: boolean;
}

/**
 * dapp-kit `createDAppKit(...)` config built from the devstack manifest.
 * Reads the network and RPC URL out of `services.sui` and returns the
 * `defaultNetwork` / `networks` / `createClient` triple.
 *
 * Throws if the manifest doesn't carry a `services.sui` entry (the
 * stack hasn't reached the sui bring-up step).
 */
export function createDappKitConfig(
	manifest: unknown,
	opts: DevstackDappKitConfigOptions = {},
): DevstackDappKitConfig {
	let resolvedRpcUrl: string | undefined = opts.rpcUrl;
	let network: Network = 'localnet';
	if (manifest !== null && manifest !== undefined && typeof manifest === 'object') {
		const sui = fromManifest(manifest).services.sui;
		if (sui !== undefined) {
			if (resolvedRpcUrl === undefined) resolvedRpcUrl = sui.rpc.url;
			network = normalizeNetwork(sui.network) ?? 'localnet';
		}
	}
	const rpcUrl = resolvedRpcUrl;
	if (rpcUrl === undefined) {
		throw new Error(
			'createDappKitConfig: no rpcUrl provided and no sui service in manifest. ' +
				'Has the supervisor reached the sui bring-up step?',
		);
	}
	const overrides = mvrOverridesFromManifest(manifest);
	const mvr =
		Object.keys(overrides.packages).length > 0
			? { overrides: { packages: overrides.packages } }
			: undefined;
	return {
		defaultNetwork: network,
		networks: [network],
		createClient: (requested: Network) => {
			if (requested !== network) {
				throw new Error(
					`createDappKitConfig: kit is configured for '${network}' only; ` +
						`createClient called with '${requested}'. The manifest pins one network — ` +
						`re-run the supervisor with --network=${requested} to switch.`,
				);
			}
			return new SuiGrpcClient({ network, baseUrl: rpcUrl, mvr });
		},
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
	};
}

function normalizeNetwork(raw: string): Network | undefined {
	if (raw === 'localnet' || raw === 'testnet' || raw === 'mainnet') return raw;
	return undefined;
}

export interface CreateDevstackDappKitOptions {
	manifest: unknown;
	/** Pass-through to dev-wallet. Default true. */
	autoConnect?: boolean;
	/** Default true — devstack auto-approves burner-wallet signing
	 * requests so e2e flows stay non-interactive. */
	autoApprove?: boolean;
	/** Default true. Set false for headless hosts (node-side rendering
	 *  tests) so the wallet UI is never mounted. */
	mountUI?: boolean;
	/** Expose the constructed kit on `globalThis.__devstackDAppKit__` so
	 * the playwright `connectAs` helper can drive account switching from
	 * `page.evaluate(...)`. Defaults to true under Vite dev / preview /
	 * `process.env.PLAYWRIGHT === '1'`; false otherwise. */
	exposeForPlaywright?: boolean;
}

/** The dapp-kit type `createDevstackDappKit` returns. */
export type DevstackDappKit = DAppKit<Network[], SuiGrpcClient>;

function shouldExposeForPlaywright(): boolean {
	const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
	if (env?.DEV === true) return true;
	if (env?.MODE === 'preview') return true;
	if (typeof process !== 'undefined' && process.env?.PLAYWRIGHT === '1') return true;
	return false;
}

/**
 * Construct a dapp-kit instance wired up for devstack: the network
 * declared in the manifest, MVR overrides for `publishMove`-emitted
 * placeholders, and the devstack burner-wallet adapter.
 *
 * Throws when the manifest doesn't carry a `services.sui` entry (the
 * supervisor hasn't reached sui bring-up yet).
 *
 * For production deploys, swap `dapp-kit.ts` for a hand-written setup
 * that calls `createDAppKit` directly with a real wallet adapter
 * (Slush, Suiet, etc.) and your own RPC selection. The devstack burner
 * wallet is for development and testing only.
 */
export async function createDevstackDappKit(
	opts: CreateDevstackDappKitOptions,
): Promise<{ dAppKit: DevstackDappKit }> {
	const mountUI = opts.mountUI ?? true;
	const devstackAdapter = createDevstackAdapterFromManifest(
		opts.manifest as Parameters<typeof createDevstackAdapterFromManifest>[0],
	);
	const dAppKit = createDAppKit({
		...createDappKitConfig(opts.manifest),
		walletInitializers: [
			devWalletInitializer({
				adapters: devstackAdapter ? [devstackAdapter] : [],
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
