// Public surface for @mysten-incubation/devstack-wallet-panels.
//
// Apps wire the panels into dev-wallet's panel API:
//
// ```ts
// import { manifest } from 'virtual:devstack-manifest';
// import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';
// import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
//
// configureDevstackPanels(manifest);
//
// const dAppKit = createDAppKit({
//   walletInitializers: [
//     devWalletInitializer({ adapters: [...], panels: devstackPanels(), mountUI: true }),
//   ],
// });
// ```

import './faucet-panel.js';
import './network-panel.js';
import './packages-panel.js';

import type { WalletPanelDescriptor } from '@mysten-incubation/dev-wallet';
import { setActiveManifest } from './manifest-context.js';
import type { DevstackManifest } from './types.js';

export type {
	DevstackManifest,
	DevstackService,
	DevstackAccount,
	DevstackPackage,
	DevstackToken,
} from './types.js';

/** Set the active devstack manifest for the panel custom elements. Call
 * once during app boot, with `manifest` from `virtual:devstack-manifest`.
 *
 * Accepts `unknown` to stay compatible with manifests produced by either
 * the typed `virtual:devstack-manifest` declaration in an app's
 * `vite-env.d.ts` or the loose `Manifest` type emitted by devstack's
 * serializer (the latter declares `tokens: unknown[]` and friends).
 * Panels narrow what they need at render time. */
export function configureDevstackPanels(manifest: unknown): void {
	setActiveManifest(manifest as DevstackManifest | null);
}

/** Default set of devstack panel descriptors. Drop into
 * `devWalletInitializer({ panels: devstackPanels() })` or compose with
 * your own via `[...devstackPanels(), myPanel]`. */
export function devstackPanels(): WalletPanelDescriptor[] {
	return [
		{
			id: 'faucet',
			label: 'Faucet',
			tagName: 'devstack-faucet-panel',
			icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4"/><path d="M5 9h14a2 2 0 0 1 0 4H5a2 2 0 0 1 0-4z"/><path d="M7 13v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-6"/></svg>',
		},
		{
			id: 'packages',
			label: 'Packages',
			tagName: 'devstack-packages-panel',
			icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/></svg>',
		},
		{
			id: 'network',
			label: 'Network',
			tagName: 'devstack-network-panel',
			icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
		},
	];
}

export { DevstackFaucetPanel } from './faucet-panel.js';
export { DevstackNetworkPanel } from './network-panel.js';
export { DevstackPackagesPanel } from './packages-panel.js';
