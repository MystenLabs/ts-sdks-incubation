// Public surface for @mysten-incubation/devstack-wallet-panels.
//
// Apps wire the panels into dev-wallet's panel API:
//
// ```ts
// import { manifest } from './generated/manifest.js';
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
 * once during app boot, with `manifest` from `./generated/manifest.js`
 * (emitted by either `@mysten-incubation/devstack` codegen or the
 * `@mysten-incubation/devstack` manifest plugin).
 *
 * Accepts both manifest shapes — old (`{ registry: { services, ... } }`)
 * and new (`{ packages, endpoints, accounts, coins }`) — and normalizes
 * to the legacy internal shape the panels render against. Panels stay
 * stable across the migration; callers don't have to care which devstack
 * emitted the manifest. */
export function configureDevstackPanels(manifest: unknown): void {
	setActiveManifest(normalizeManifest(manifest));
}

interface NewManifestShape {
	packages?: Array<{ name: string; packageId: string; captured?: Record<string, string>; path?: string }>;
	endpoints?: Array<{ name: string; url: string; kind?: string; pairUrl?: string }>;
	accounts?: Array<{ name: string; address: string }>;
	coins?: Array<{ name: string; type: string; decimals: number }>;
}

function normalizeManifest(manifest: unknown): DevstackManifest | null {
	if (manifest === null || manifest === undefined) return null;
	const m = manifest as { registry?: unknown } & NewManifestShape;
	// Old shape passes through unchanged.
	if (m.registry !== undefined) return manifest as DevstackManifest;
	// New shape — project into the internal old shape.
	return {
		app: '',
		network: 'localnet',
		emittedAt: new Date().toISOString(),
		registry: {
			services: (m.endpoints ?? []).map((e) => ({
				name: e.name,
				kind: e.kind ?? e.name,
				url: e.url,
				port: tryParsePort(e.url),
				...(e.pairUrl !== undefined ? { endpointLabel: e.pairUrl } : {}),
			})),
			accounts: (m.accounts ?? []).map((a) => ({ name: a.name, address: a.address })),
			packages: (m.packages ?? []).map((p) => ({
				name: p.name,
				packageId: p.packageId,
				captured: p.captured ?? {},
				...(p.path !== undefined ? { path: p.path } : {}),
			})),
			coin: { tokens: (m.coins ?? []).map((c) => ({ name: c.name, type: c.type, decimals: c.decimals })) },
		},
	};
}

function tryParsePort(url: string): number {
	try {
		const u = new URL(url);
		return Number(u.port) || 0;
	} catch {
		return 0;
	}
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
