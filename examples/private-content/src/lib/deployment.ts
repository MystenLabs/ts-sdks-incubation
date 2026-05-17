// App-level projection of the devstack manifest. Surfaces the
// vault package, the seal key server (via `app.extras`), the walrus
// daemon URL, and a flat account name → address map — all sourced
// from the generated stack handles so app code never touches the
// raw manifest.

import { accounts } from '../generated/accounts.js';
import { extras } from '../generated/extras.js';
import { packages } from '../generated/packages.js';
import { services } from '../generated/services.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	sealPackageId: string;
}

interface SealKeyServerExtras {
	objectId: string;
	url: string;
}

const sealKeyServer = (extras as { sealKeyServer?: SealKeyServerExtras }).sealKeyServer;
// `Seal({ signer })` publishes the seal package under the `seal.publish`
// name (composite ref), so the manifest entry is `seal.publish` rather
// than `seal`.
const sealPackage = (packages as Record<string, { id: string } | undefined>)['seal.publish'];

const seal: SealView | undefined =
	sealKeyServer !== undefined && sealPackage !== undefined
		? {
				keyServerObjectId: sealKeyServer.objectId,
				keyServerUrl: sealKeyServer.url,
				sealPackageId: sealPackage.id,
			}
		: undefined;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	walrusDaemonUrl: services.walrus?.publisher.url,
	accounts,
	vaultPackageId: packages.vault?.id,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
