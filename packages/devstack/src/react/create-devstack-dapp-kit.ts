// One-line dapp-kit setup for devstack-backed apps. Replaces the byte-
// identical `dapp-kit.ts` boilerplate that used to live in every example.
//
// Apps now do (in `dapp-kit.ts` or inline in main.tsx):
//
// ```ts
// import { manifest } from './generated/manifest.js';
// import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
//
// export const { dAppKit } = await createDevstackDappKit({ manifest });
//
// // Apps still locally augment dapp-kit-react so `useCurrentAccount()`
// // etc. carry the right kit type:
// declare module '@mysten/dapp-kit-react' {
//   interface Register {
//     dAppKit: typeof dAppKit;
//   }
// }
// ```
//
// Ships from the `/react` subpath alongside the other dapp-kit-coupled
// helpers; CLI / supervisor consumers don't pull this in. Pairs with the
// server-side `walletApp({ port })` plugin in the main package — the
// import subpath disambiguates the role.

import type { DAppKit } from '@mysten/dapp-kit-core';
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import type { WalletPanelDescriptor } from '@mysten-incubation/dev-wallet';

// Inline the network string union to keep the public return type from
// referencing devstack's `core/types.ts` — TypeScript otherwise emits
// the path into example apps' .d.ts (TS2742) on portability checks.
type Network = 'localnet' | 'testnet' | 'mainnet';

interface ManifestRegistryShape {
	registry?: {
		services?: Array<{ name: string; url: string }>;
		packages?: Array<{ name: string; packageId: string; mvrPlaceholder?: string }>;
	};
}

interface ManifestNetworkShape {
	network?: Network;
}

export interface LocalnetMvrOverrides {
	packages: Record<string, string>;
}

/**
 * Build MVR-style package overrides from the devstack manifest. Each
 * package whose `mvrPlaceholder` was published by the `codegen()` plugin
 * becomes a `placeholder → packageId` entry. Spread into
 * `SuiGrpcClient`'s `mvr.overrides` so the SDK's `namedPackagesPlugin`
 * resolves codegen-emitted placeholders to live `packageId`s at
 * transaction build time.
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
export function localnetMvrOverrides(manifest: unknown): LocalnetMvrOverrides {
	const m = manifest as ManifestRegistryShape | undefined;
	const packages: Record<string, string> = {};
	for (const p of m?.registry?.packages ?? []) {
		if (p.mvrPlaceholder !== undefined) {
			packages[p.mvrPlaceholder] = p.packageId;
		}
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
			'localnetDappKitConfig: no localnetRpcUrl provided and no `sui-rpc` service in manifest. Has `devstack up` reached the sui plugin?',
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

export interface CreateDevstackDappKitOptions {
	manifest: unknown;
	/** Pass-through to dev-wallet. Default true. */
	autoConnect?: boolean;
	/** Pass-through to dev-wallet. Default true (devstack auto-approves
	 * burner-wallet signing requests so e2e flows stay non-interactive). */
	autoApprove?: boolean;
	/** Pass-through to dev-wallet. Default true. Set false for headless
	 * hosts where the floating UI shouldn't render (e.g. node-side
	 * rendering tests). When false, the devstack panels module is NOT
	 * loaded — production bundles drop the panels code entirely. */
	mountUI?: boolean;
	/** Expose the constructed kit on `globalThis.__devstackDAppKit__` so
	 * the playwright `connectAs` helper can drive account switching from
	 * `page.evaluate(...)`. Defaults to true when any of the following
	 * holds:
	 *
	 * - `import.meta.env.DEV` is true (Vite dev server),
	 * - `import.meta.env.MODE === 'preview'` (Vite preview server, when
	 *   apps explicitly opt their preview mode in),
	 * - `process.env.PLAYWRIGHT === '1'` (set by Playwright workers, and
	 *   easy to forward from a `playwright.config.ts` `webServer.env`
	 *   block when targeting `pnpm preview` builds).
	 *
	 * Otherwise defaults to false — shipped builds shouldn't leak the
	 * kit onto `window`. Apps that want the handle exposed under a
	 * production build for self-driving e2e can pass `true` explicitly. */
	exposeForPlaywright?: boolean;
}

/** The dapp-kit type `createDevstackDappKit` returns. Apps usually
 * access this via `typeof dAppKit` after destructuring; exporting the
 * alias lets consumers reference it without importing the
 * dapp-kit-core internals. */
export type DevstackDappKit = DAppKit<('localnet' | 'testnet' | 'mainnet')[], SuiGrpcClient>;

/** Default predicate for `exposeForPlaywright`. Returns true under any
 * of the three signals the playwright harness can plausibly hit:
 *
 * - Vite dev server: `import.meta.env.DEV === true`.
 * - Vite preview server: `import.meta.env.MODE === 'preview'`. Vite
 *   defaults preview's MODE to `'production'`, so this only fires when
 *   apps explicitly opt in via `vite preview --mode preview` or a
 *   custom mode in their preview script.
 * - Playwright env: `process.env.PLAYWRIGHT === '1'`. Set by Playwright
 *   workers themselves, and easy to forward to a `webServer` via
 *   `playwright.config.ts`'s `webServer.env`. Guarded by `typeof
 *   process` so pure-browser bundles (where `process` is undefined)
 *   don't ReferenceError.
 *
 * Falls back to false in shipped builds so the kit doesn't leak onto
 * `window`. */
function shouldExposeForPlaywright(): boolean {
	// `import.meta.env` is Vite-injected at build time. The cast is
	// intentional — the field doesn't exist on Node's `import.meta`, and
	// a typed declaration would force every consumer to ship the
	// vite/client types in their tsconfig.
	const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
	if (env?.DEV === true) return true;
	if (env?.MODE === 'preview') return true;
	// `typeof process` guard keeps this safe in pure-browser bundles
	// where `process` is undefined (Vite leaves the reference alone if
	// it can't statically resolve it).
	if (typeof process !== 'undefined' && process.env?.PLAYWRIGHT === '1') return true;
	return false;
}

/**
 * Construct a dapp-kit instance wired up for devstack: localnet network
 * config, MVR overrides for codegen-emitted placeholders, the devstack
 * burner-wallet adapter, and (optionally) the devstack panels (Faucet,
 * Packages, Network).
 *
 * Returns `{ dAppKit }`. Apps then locally augment
 * `@mysten/dapp-kit-react`'s `Register` interface against `typeof
 * dAppKit` so `useCurrentAccount()` and friends pick up the right
 * network/client types.
 *
 * **Localnet only.** This factory throws when `manifest.network !==
 * 'localnet'`. The manifest carries dev-only material (a bearer token
 * for the devstack wallet-app signer, MVR placeholder overrides) that
 * doesn't apply on testnet/mainnet. For production deploys, swap
 * `dapp-kit.ts` for a hand-written setup that calls `createDAppKit`
 * directly with a real wallet adapter (Slush, Suiet, etc.) and only
 * the live-net manifest fields the app actually needs.
 *
 * The function is `async` so it can lazy-load the panels module under
 * `mountUI: true`. Bundlers tree-shake the panels import out of
 * production builds when `mountUI: false`. Callers `await` once at
 * boot.
 *
 * @example
 * ```ts
 * // src/dapp-kit.ts
 * import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
 * import { manifest } from './generated/manifest';
 *
 * export const { dAppKit } = await createDevstackDappKit({ manifest });
 * ```
 */
export async function createDevstackDappKit(
	opts: CreateDevstackDappKitOptions,
): Promise<{ dAppKit: DevstackDappKit }> {
	const network = (opts.manifest as ManifestNetworkShape | undefined)?.network;
	if (network !== undefined && network !== 'localnet') {
		throw new Error(
			`createDevstackDappKit: only supports localnet manifests. Got network='${network}'.\n\n` +
				`For testnet/mainnet builds, replace src/dapp-kit.ts with a hand-written setup using ` +
				`@mysten/dapp-kit-core's createDAppKit() and a real wallet adapter (Slush, Suiet, etc.).\n\n` +
				`See: https://github.com/MystenLabs/ts-sdks-incubation/blob/main/packages/devstack/README.md#production-builds`,
		);
	}
	const mountUI = opts.mountUI ?? true;
	// Dynamic import keeps the ~30KB panels module out of bundles where
	// `mountUI: false` — Vite/Rollup tree-shake the unreached branch.
	// The try/catch is best-effort: if the panels module fails to load
	// (network blip on a fresh dev server, optional dep stripped from a
	// minimal install), the app still boots with a working `dAppKit`
	// and just logs a warning instead of rendering a blank page.
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
	// `createDevstackAdapterFromManifest`'s parameter type narrows to a
	// specific manifest shape; the runtime check (look up `wallet-app`
	// via optional chaining) tolerates anything, so the cast is safe.
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
		// Vite HMR: when the module re-evaluates after an edit, drop the
		// stale kit so `connectAs` doesn't read a defunct handle. Only
		// runs under Vite (the API is undefined in production / Node).
		const meta = import.meta as { hot?: { dispose: (cb: () => void) => void } };
		meta.hot?.dispose(() => {
			if (slot.__devstackDAppKit__ === dAppKit) {
				slot.__devstackDAppKit__ = undefined;
			}
		});
	}
	return { dAppKit };
}
