// Network mode discriminator. Substrate-level shape; the concrete
// `NetworkResolver` contract that produces these lives under
// `contracts/network-resolver.ts`.

import type { ChainId } from './brand.ts';

/** Network mode registry. Architecture: fork is a network mode, not
 *  an orchestrator. Module augmentation can add modes without widening
 *  every config field. */
export interface DevstackNetworkModeRegistry {
	readonly local: { readonly rpc?: string };
	readonly live: { readonly rpc?: string };
	readonly fork: { readonly rpc?: string; readonly checkpoint?: string };
}

export type NetworkMode = keyof DevstackNetworkModeRegistry & string;

/** Substrate-level network record. Plugins consult the resolver once
 *  per acquire and get this back. */
export type NetworkConfig<Mode extends NetworkMode = NetworkMode> = Readonly<
	{
		readonly mode: Mode;
		/** Chain identity the plugin uses for cache-key folding, ChainProbe
		 *  dispatch, etc. Branded so downstream lookups (chain-probe /
		 *  faucet capability keys) accept it without a re-wrap. */
		readonly chain: ChainId;
		/** Source provenance for renderer display. */
		readonly source?: 'cli' | 'env' | 'config' | 'default';
	} & DevstackNetworkModeRegistry[Mode]
>;

/** Default network shape used when nothing is pinned. */
export type DefaultNetwork = NetworkConfig<'local'>;
