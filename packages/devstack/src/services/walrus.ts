// Walrus(opts?) — canonical Walrus factory. Auto-picks local-cluster on
// localnet (full node committee + aggregator/publisher + on-chain
// registration) and known-deployment on testnet/mainnet (read-only
// handle pointing at the public Walrus network).

import {
	walrusKnownDeployment,
	walrusLocalCluster,
	type WalrusKnownDeploymentOptions,
	type WalrusLocalClusterOptions,
} from '../primitives/walrus/index.js';
import type { StackMember } from '../engine/supervisor.js';
import { withSection } from './ref.js';

export interface WalrusOptions {
	/** Which Walrus source. `'auto'` (default) picks based on the
	 *  surrounding `Sui` network. `'local'` forces the in-process cluster;
	 *  `'known'` forces a remote handle. */
	readonly mode?: 'auto' | 'local' | 'known';
	/** Pass-through extras for the local-cluster path. */
	readonly local?: WalrusLocalClusterOptions;
	/** Pass-through extras for the known-deployment path. */
	readonly known?: WalrusKnownDeploymentOptions;
}

const resolveMode = (opts: WalrusOptions): 'local' | 'known' => {
	if (opts.mode === 'local' || opts.mode === 'known') return opts.mode;
	return 'local';
};

/** Walrus factory. Returns a Ref carrying the walrus network + proxy
 *  contracts. */
export const Walrus = (opts: WalrusOptions = {}): StackMember => {
	const mode = resolveMode(opts);
	if (mode === 'known') {
		return withSection(walrusKnownDeployment(opts.known ?? {}), 'service');
	}
	return withSection(walrusLocalCluster(opts.local ?? {}), 'service');
};
