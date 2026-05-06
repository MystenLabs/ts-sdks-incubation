// App-level projection of the codegen-emitted typed manifest. Surfaces the
// connect_four package id and the openLobby shared object the UI reaches
// for, plus a flat account name → address map.

import {
	defineManifestKind,
	selectAccountMap,
	selectPackage,
	selectService,
} from '@mysten-incubation/devstack';
import { manifest } from '../generated/manifest.js';

interface ArenaSharedObject {
	name: string;
	objectId: string;
	objectType?: string;
}
const arenaSharedObjects = defineManifestKind<ArenaSharedObject>('arena.sharedObjects');

const accountMap = selectAccountMap(manifest);

export const deployment = {
	rpcUrl: selectService(manifest, 'sui-rpc')?.url ?? '',
	faucetUrl: selectService(manifest, 'sui-faucet')?.url,
	accounts: accountMap,
	connectFourPackageId: selectPackage(manifest, 'connect_four')?.packageId,
	openLobbyId: arenaSharedObjects(manifest).find((o) => o.name === 'openLobby')?.objectId,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
