// App-level projection of generated stack bindings.
//
// The vault package is MVR-resolved: tx moveCalls use the vault binding
// defaults (resolved by the grpc client's MVR overrides, see `dapp-kit.ts`),
// and the non-moveCall Seal/query consumers import `vaultPackageId` from
// `../dapp-kit.js`. `config.network` lives solely in `dapp-kit.ts`, so this
// module no longer reads the generated `config` directly — only the
// non-MVR seal + walrus runtime bindings.

import { vaultPackageId } from '../dapp-kit.js';
import { seal } from '@generated/seal.js';
import { walrus } from '@generated/walrus.js';

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

export const deployment = {
	seal: sealView,
	walrus,
} as const;

export const isDeployed: boolean =
	vaultPackageId !== undefined &&
	deployment.walrus.packageConfig.systemObjectId.length > 0 &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
