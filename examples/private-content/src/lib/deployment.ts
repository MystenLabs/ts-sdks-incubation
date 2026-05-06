// App-level projection of the codegen-emitted typed manifest. Surfaces the
// vault package, the seal key server, the walrus-daemon URL, and a flat
// account name → address map.

import {
	defineManifestKind,
	selectAccountMap,
	selectPackage,
	selectService,
} from '@mysten-incubation/devstack';
import { manifest } from '../generated/manifest.js';

interface SealKeyServer {
	name: string;
	objectId: string;
	url: string;
	sealPackageId: string;
}
const sealKeyServers = defineManifestKind<SealKeyServer>('seal.keyServer');
const sealKeyServer = sealKeyServers(manifest)[0];

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
	rpcUrl: selectService(manifest, 'sui-rpc')?.url ?? '',
	faucetUrl: selectService(manifest, 'sui-faucet')?.url,
	walrusDaemonUrl: selectService(manifest, 'walrus-daemon')?.url,
	accounts: selectAccountMap(manifest),
	vaultPackageId: selectPackage(manifest, 'vault')?.packageId,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
