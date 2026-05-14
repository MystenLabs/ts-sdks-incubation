// App-level projection of the devstack manifest. Surfaces the
// vault package, the seal key server (via `extras`), the walrus daemon
// URL, and a flat account name → address map.

import { manifest } from '../generated/manifest.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	sealPackageId: string;
}

interface SealKeyServerExtras {
	objectId: string;
	url: string;
	name: string;
}

const sealKeyServer = manifest.extras.sealKeyServer as SealKeyServerExtras | undefined;
// `sealLocalKeygen` registers the published seal package under
// `<name>.publish` (default name `seal`), so the manifest entry is
// `seal.publish`, not `seal`.
const sealPackage = manifest.packages.find((p) => p.name === 'seal.publish');

const seal: SealView | undefined =
	sealKeyServer !== undefined && sealPackage !== undefined
		? {
				keyServerObjectId: sealKeyServer.objectId,
				keyServerUrl: sealKeyServer.url,
				sealPackageId: sealPackage.packageId,
			}
		: undefined;

export const deployment = {
	rpcUrl: manifest.endpoints.find((e) => e.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.endpoints.find((e) => e.name === 'sui-faucet')?.url,
	walrusDaemonUrl: manifest.endpoints.find((e) => e.name === 'walrus-proxy')?.url,
	accounts: Object.fromEntries(manifest.accounts.map((a) => [a.name, a.address])),
	vaultPackageId: manifest.packages.find((p) => p.name === 'vault')?.packageId,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
