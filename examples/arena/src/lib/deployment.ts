// App-level projection of the codegen-emitted typed manifest. Surfaces the
// connect_four package id and the openLobby shared object the UI reaches
// for, plus a flat account name → address map.

import { manifest } from '../generated/manifest.js';

interface ArenaNamespace {
	sharedObjects?: ReadonlyArray<{ name: string; objectId: string; objectType?: string }>;
}

const services = manifest.registry.services;
const accounts = manifest.registry.accounts;
const packages = manifest.registry.packages;
const sharedObjects =
	(manifest.registry.arena as ArenaNamespace | undefined)?.sharedObjects ?? [];

const accountMap: Record<string, string> = Object.fromEntries(
	accounts.map((a) => [a.name, a.address]),
);

export const deployment = {
	rpcUrl: services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: services.find((s) => s.name === 'sui-faucet')?.url,
	accounts: accountMap,
	connectFourPackageId: packages.find((p) => p.name === 'connect_four')?.packageId,
	openLobbyId: sharedObjects.find((o) => o.name === 'openLobby')?.objectId,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
