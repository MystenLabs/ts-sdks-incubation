// App-level projection of the devstack manifest. Surfaces the
// vault package, the seal key server (via `app.extras`), the walrus
// daemon URL, and a flat account name → address map.

import { manifest } from '../generated/manifest.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	sealPackageId: string;
}

interface SealKeyServerExtras {
	objectId: string;
	url: string;
}

const sealKeyServer = manifest.app.extras.sealKeyServer as SealKeyServerExtras | undefined;
// `sealLocalKeygen` registers the published seal package under
// `<name>.publish` (default name `seal`), so the manifest entry is
// `seal.publish`, not `seal`.
const sealPackage = manifest.packages['seal.publish'];

const seal: SealView | undefined =
	sealKeyServer !== undefined && sealPackage !== undefined
		? {
				keyServerObjectId: sealKeyServer.objectId,
				keyServerUrl: sealKeyServer.url,
				sealPackageId: sealPackage.id,
			}
		: undefined;

export const deployment = {
	rpcUrl: manifest.services.sui?.rpc.url ?? '',
	faucetUrl: manifest.services.sui?.faucet?.url,
	walrusDaemonUrl: manifest.services.walrus?.publisher.url,
	accounts: Object.fromEntries(
		Object.entries(manifest.accounts).map(([name, a]) => [name, a.address]),
	),
	vaultPackageId: manifest.packages['vault']?.id,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
