// App-level projection of generated stack bindings.

import { accounts } from '../generated/accounts.js';
import { packages } from '../generated/packages.js';
import { sealBindings } from '../generated/seal/seal.js';
import { services } from '../generated/services.js';
import { walrus } from '../generated/walrus/network.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	serverConfigs: typeof sealBindings.serverConfigs;
}

const seal: SealView = {
	keyServerObjectId: sealBindings.objectId,
	keyServerUrl: sealBindings.keyServerUrl,
	serverConfigs: sealBindings.serverConfigs,
};

const walletAccounts = {
	publisher: accounts.publisher,
	alice: accounts.alice,
	bob: accounts.bob,
} as const;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	accounts: walletAccounts,
	vaultPackageId: packages.vault?.packageId,
	seal,
	walrus,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.walrus.packageConfig.systemObjectId.length > 0 &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
