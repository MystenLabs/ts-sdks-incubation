// One-line dapp-kit setup for devstack-backed apps. Replaces the byte-
// identical `dapp-kit.ts` boilerplate that used to live in every example.
//
// Apps now do (in `dapp-kit.ts` or inline in main.tsx):
//
// ```ts
// import { manifest } from 'virtual:devstack-manifest';
// import { createWalletApp } from '@mysten-incubation/devstack/app-setup';
//
// export const { dAppKit } = createWalletApp({ manifest });
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
// Lives at the `/app-setup` subpath rather than the main barrel because
// it pulls in `@mysten/dapp-kit-core` + `@mysten-incubation/dev-wallet`
// + `@mysten-incubation/devstack-wallet-panels`. CLI / supervisor
// consumers don't need any of that.

import type { DAppKit } from '@mysten/dapp-kit-core';
import { createDAppKit } from '@mysten/dapp-kit-core';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';

import { localnetDappKitConfig } from '../react/index.js';

export interface CreateWalletAppOptions {
	manifest: unknown;
	/** Pass-through to dev-wallet. Default true. */
	autoConnect?: boolean;
	/** Pass-through to dev-wallet. Default true (devstack auto-approves
	 * burner-wallet signing requests so e2e flows stay non-interactive). */
	autoApprove?: boolean;
	/** Pass-through to dev-wallet. Default true. Set false for headless
	 * hosts where the floating UI shouldn't render (e.g. node-side
	 * rendering tests). */
	mountUI?: boolean;
	/** Expose the constructed kit on `globalThis.__devstackDAppKit__` so
	 * the playwright `connectAs` helper can drive account switching from
	 * `page.evaluate(...)`. Defaults to true under DEV (vite dev server)
	 * and false otherwise — production builds shouldn't leak the kit
	 * onto `window`. */
	exposeForPlaywright?: boolean;
}

/** The dapp-kit type `createWalletApp` returns. Apps usually access this
 * via `typeof dAppKit` after destructuring; exporting the alias lets
 * consumers reference it without importing the dapp-kit-core internals. */
export type DevstackDappKit = DAppKit<('localnet' | 'testnet' | 'mainnet')[], SuiGrpcClient>;

/** Detect whether we're running under a Vite dev server. Used to
 * default `exposeForPlaywright` so production builds don't leak the
 * kit. Falls back to false outside Vite (Node tests, SSR). */
function isDevBuild(): boolean {
	// `import.meta.env` is Vite-injected at build time. The `as any` cast
	// is intentional — the field doesn't exist on Node's `import.meta`,
	// and a typed declaration would force every consumer to ship the
	// vite/client types in their tsconfig.
	const env = (import.meta as { env?: { DEV?: boolean } }).env;
	return env?.DEV === true;
}

/**
 * Construct a dapp-kit instance wired up for devstack: localnet network
 * config, MVR overrides for codegen-emitted placeholders, the devstack
 * burner-wallet adapter, and the devstack panels (Faucet, Packages,
 * Network).
 *
 * Returns `{ dAppKit }`. Apps then locally augment
 * `@mysten/dapp-kit-react`'s `Register` interface against `typeof
 * dAppKit` so `useCurrentAccount()` and friends pick up the right
 * network/client types.
 */
export function createWalletApp(opts: CreateWalletAppOptions): {
	dAppKit: DevstackDappKit;
} {
	configureDevstackPanels(opts.manifest);
	// `createDevstackAdapterFromManifest`'s parameter type narrows to a
	// specific manifest shape; the runtime check (look up `wallet-server`
	// via optional chaining) tolerates anything, so the cast is safe.
	const devstackAdapter = createDevstackAdapterFromManifest(
		opts.manifest as Parameters<typeof createDevstackAdapterFromManifest>[0],
	);
	const dAppKit = createDAppKit({
		...localnetDappKitConfig(opts.manifest),
		walletInitializers: [
			devWalletInitializer({
				adapters: devstackAdapter ? [devstackAdapter] : [],
				panels: devstackPanels(),
				autoConnect: opts.autoConnect ?? true,
				autoApprove: opts.autoApprove ?? true,
				mountUI: opts.mountUI ?? true,
			}),
		],
	});
	const exposeForPlaywright = opts.exposeForPlaywright ?? isDevBuild();
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
