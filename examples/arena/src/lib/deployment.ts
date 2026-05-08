// App-level projection of the codegen-emitted typed manifest. Surfaces the
// connect_four package id and the openLobby shared object the UI reaches
// for, plus a flat account name → address map.

import { defineManifestKind } from '@mysten-incubation/devstack';
import { manifest } from '../generated/manifest.js';

interface ArenaSharedObject {
	name: string;
	objectId: string;
	objectType?: string;
}
const arenaSharedObjects = defineManifestKind<ArenaSharedObject>('arena.sharedObjects');

const accountMap = Object.fromEntries(manifest.registry.accounts.map((a) => [a.name, a.address]));

export const deployment = {
	rpcUrl: manifest.registry.services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.registry.services.find((s) => s.name === 'sui-faucet')?.url,
	accounts: accountMap,
	connectFourPackageId: manifest.registry.packages.find((p) => p.name === 'connect_four')
		?.packageId,
	openLobbyId: arenaSharedObjects(manifest).find('openLobby')?.objectId,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
