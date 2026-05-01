// Frontend-facing projection of the devstack manifest. The vite plugin reads
// the active stack's manifest at `.devstack/stacks/<active>/manifest.json`
// and re-exports it as `virtual:devstack-manifest`; we narrow it into the few
// keys the UI cares about, with a defensive empty-shape fallback for the
// pre-`localnet:up` state (the plugin returns a typed empty stub when no
// JSON exists yet).

import { manifest } from './manifest.js';

const registry = (manifest as { registry?: unknown }).registry as
	| {
			services?: Array<{ name: string; url: string }>;
			accounts?: Array<{ name: string; address: string }>;
			packages?: Array<{ name: string; packageId: string }>;
			arena?: { sharedObjects?: Array<{ name: string; objectId: string }> };
	  }
	| undefined;

const services = registry?.services ?? [];
const accounts = registry?.accounts ?? [];
const packages = registry?.packages ?? [];
const sharedObjects = registry?.arena?.sharedObjects ?? [];

const accountMap: Record<string, string> = Object.fromEntries(
	accounts.map((a) => [a.name, a.address]),
);

export const deployment = {
	rpcUrl: services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: services.find((s) => s.name === 'sui-faucet')?.url,
	accounts: accountMap,
	connectFourPackageId: packages.find((p) => p.name === 'connect_four')?.packageId,
	openLobbyId: sharedObjects.find((o) => o.name === 'openLobby')?.objectId,
	publishedAt: manifest.emittedAt ?? '',
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
