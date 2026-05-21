// Network mode discriminator. Substrate-level shape; the concrete
// `NetworkResolver` contract that produces these lives under
// `contracts/network-resolver.ts`.

import type { ChainId } from './brand.ts';

/** Closed mode set. Architecture: fork is a network mode, not an
 *  orchestrator. */
export type NetworkMode = 'local' | 'live' | 'fork';

/** Substrate-level network record. Plugins consult the resolver once
 *  per acquire and get this back. */
export interface NetworkConfig<Mode extends NetworkMode = NetworkMode> {
	readonly mode: Mode;
	/** Chain identity the plugin uses for cache-key folding, ChainProbe
	 *  dispatch, etc. Branded so downstream lookups (chain-probe /
	 *  faucet capability keys) accept it without a re-wrap. */
	readonly chain: ChainId;
	/** Optional RPC URL override. */
	readonly rpc?: string;
	/** Source provenance for renderer display. */
	readonly source?: 'cli' | 'env' | 'config' | 'default';
	/** Fork-specific: checkpoint identifier the fork started from. */
	readonly checkpoint?: string;
}

/** Default network shape used when nothing is pinned. */
export type DefaultNetwork = NetworkConfig<'local'>;
