// App-level projection of the codegen-emitted typed manifest. Surfaces the
// vault package, the seal key server, the walrus-daemon URL, and a flat
// account name → address map.

import { defineManifestKind } from '@mysten-incubation/devstack';
import { manifest } from '../generated/manifest.js';

interface SealKeyServer {
	name: string;
	objectId: string;
	url: string;
	sealPackageId: string;
}
const sealKeyServers = defineManifestKind<SealKeyServer>('seal.keyServer');
const sealKeyServer = sealKeyServers(manifest).list()[0];

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	sealPackageId: string;
}

const seal: SealView | undefined =
	sealKeyServer === undefined
		? undefined
		: {
				keyServerObjectId: sealKeyServer.objectId,
				keyServerUrl: sealKeyServer.url,
				sealPackageId: sealKeyServer.sealPackageId,
			};

export const deployment = {
	rpcUrl: manifest.registry.services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.registry.services.find((s) => s.name === 'sui-faucet')?.url,
	walrusDaemonUrl: manifest.registry.services.find((s) => s.name === 'walrus-daemon')?.url,
	accounts: Object.fromEntries(manifest.registry.accounts.map((a) => [a.name, a.address])),
	vaultPackageId: manifest.registry.packages.find((p) => p.name === 'vault')?.packageId,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
