// Frontend-facing projection of the devstack manifest. The vite plugin reads
// the active stack's manifest at `.devstack/stacks/<active>/manifest.json`
// and re-exports it as `virtual:devstack-manifest`; this adapter narrows it
// into the keys the UI reads, with empty-shape fallbacks so the app
// renders before the first `localnet:up`.

import { manifest } from './manifest.js';

const registry = (manifest as { registry?: unknown }).registry as
	| {
			services?: Array<{ name: string; url: string }>;
			accounts?: Array<{ name: string; address: string }>;
			packages?: Array<{ name: string; packageId: string; captured: Record<string, string> }>;
	  }
	| undefined;

const services = registry?.services ?? [];
const accounts = registry?.accounts ?? [];
const packages = registry?.packages ?? [];

const accountMap: Record<string, string> = Object.fromEntries(
	accounts.map((a) => [a.name, a.address]),
);

const managedCoin = packages.find((p) => p.name === 'managed_coin');
const packageId = managedCoin?.packageId ?? '0x0';

export const deployment = {
	rpcUrl: services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: services.find((s) => s.name === 'sui-faucet')?.url,
	packageId,
	managedCoinType: `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: managedCoin?.captured.treasuryCapId ?? '',
	metadataId: managedCoin?.captured.metadataId ?? '',
	upgradeCapId: managedCoin?.captured.upgradeCapId ?? '',
	accounts: accountMap as Record<'alice' | 'bob' | 'carol', string>,
	publishedAt: manifest.emittedAt ?? '',
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
