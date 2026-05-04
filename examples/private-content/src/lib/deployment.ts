// App-level projection of the codegen-emitted typed manifest. Surfaces the
// vault package, the seal key server, the walrus-daemon URL, and a flat
// account name → address map.

import { manifest } from '../generated/manifest.js';

interface SealNamespace {
	keyServer?: ReadonlyArray<{
		name: string;
		objectId: string;
		url: string;
		sealPackageId: string;
	}>;
}

const services = manifest.registry.services;
const accounts = manifest.registry.accounts;
const packages = manifest.registry.packages;
const sealKeyServer = (manifest.registry.seal as SealNamespace | undefined)?.keyServer?.[0];

const accountMap: Record<string, string> = Object.fromEntries(
	accounts.map((a) => [a.name, a.address]),
);

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
	rpcUrl: services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: services.find((s) => s.name === 'sui-faucet')?.url,
	walrusDaemonUrl: services.find((s) => s.name === 'walrus-daemon')?.url,
	accounts: accountMap,
	vaultPackageId: packages.find((p) => p.name === 'vault')?.packageId,
	seal,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 &&
	deployment.vaultPackageId !== undefined &&
	deployment.seal !== undefined;

export type Deployment = typeof deployment;
