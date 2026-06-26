// App-level projection of generated stack bindings.
//
// The vault package is MVR-resolved: tx moveCalls use the vault binding
// defaults (resolved by the grpc client's MVR overrides, see `dapp-kit.ts`),
// and the non-moveCall Seal/query consumers resolve the vault id per network
// via `vaultPackageIdFor` from `../dapp-kit.js`. Everything here is keyed by
// the dapp-kit-selected network so a runtime `switchNetwork` flips the seal +
// walrus service ids in lockstep.

import { vaultPackageIdFor } from '../dapp-kit.js';
import { config } from '@generated/config.js';
import { DevstackConfigMissingError } from '@generated/config-runtime.js';
import { seal } from '@generated/seal.js';
import { walrus } from '@generated/walrus.js';

export interface SealView {
	keyServerObjectId: string;
	keyServerUrl: string;
	serverConfigs: ReturnType<typeof seal.forNetwork>['seal']['serverConfigs'];
	verifyKeyServers: boolean;
}

/** Project the generated seal + walrus bindings for `network` into the
 *  app-level shape consumed by the Seal/Walrus libs. */
export function deploymentForNetwork(network: string) {
	const s = seal.forNetwork(network).seal;
	const w = walrus.forNetwork(network);
	const sealView: SealView = {
		keyServerObjectId: s.objectId,
		keyServerUrl: s.keyServerUrl,
		serverConfigs: s.serverConfigs,
		verifyKeyServers: s.verifyKeyServers,
	};
	return { seal: sealView, walrus: w } as const;
}

export type Deployment = ReturnType<typeof deploymentForNetwork>;

/** Whether the given network has the vault package + walrus + seal bindings
 *  resolved (i.e. the stack has been applied for that network). NON-THROWING:
 *  this runs bare in render to gate the deployed view, so an unknown/undeployed
 *  network must return `false`, not throw. Two guards: (1) the network must be
 *  present in the injected envelope (`config.networks[network]`) — `forNetwork`
 *  throws otherwise; (2) the per-service projection (`seal`/`walrus`
 *  `forNetwork`) resolves required values via `requireValue`, which throws
 *  `DevstackConfigMissingError` when a service hasn't been applied — caught here
 *  and reported as undeployed. */
export function isDeployedForNetwork(network: string): boolean {
	if (config.networks[network] === undefined) return false;
	try {
		const d = deploymentForNetwork(network);
		return (
			vaultPackageIdFor(network) !== undefined &&
			d.walrus.packageConfig.systemObjectId.length > 0 &&
			d.seal !== undefined
		);
	} catch (cause) {
		if (cause instanceof DevstackConfigMissingError) return false;
		throw cause;
	}
}
