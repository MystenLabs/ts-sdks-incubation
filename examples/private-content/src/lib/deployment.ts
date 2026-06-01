// App-level projection of generated stack bindings.

import { config } from '@generated/config.js';
import { seal } from '@generated/seal.js';
import { walrus } from '@generated/walrus.js';
import { accounts } from '@devstack-dev/accounts.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	serverConfigs: typeof seal.seal.serverConfigs;
}

const sealView: SealView = {
	keyServerObjectId: seal.seal.objectId,
	keyServerUrl: seal.seal.keyServerUrl,
	serverConfigs: seal.seal.serverConfigs,
};

const walletAccounts = {
	publisher: accounts.publisher,
	alice: accounts.alice,
	bob: accounts.bob,
} as const;

export const deployment = {
	rpcUrl: config.networks[config.network].rpc ?? '',
	faucetUrl: config.networks[config.network].faucet,
	accounts: walletAccounts,
	vaultPackageId: config.packages.vault?.packageId,
	seal: sealView,
	walrus,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.walrus.packageConfig.systemObjectId.length > 0 &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
