// Network mode discriminator. Substrate-level shape consumed by the
// `IdentityContext` + `DevstackOptions.network` resolution path (no
// dedicated NetworkResolver contract — identity threads through Context
// directly).

/** Network mode registry. Architecture: fork is a network mode, not
 *  an orchestrator. Module augmentation can add modes without widening
 *  every config field. */
export interface DevstackNetworkModeRegistry {
	readonly local: { readonly rpc?: string };
	readonly live: { readonly rpc?: string };
	readonly fork: { readonly rpc?: string; readonly checkpoint?: string };
}

export type NetworkMode = keyof DevstackNetworkModeRegistry & string;

/** Substrate-level network record. Plugins read this from the
 *  `IdentityContext` projection — one value per acquire. */
export type NetworkConfig<Mode extends NetworkMode = NetworkMode> = Readonly<
	{
		readonly mode: Mode;
		/** Chain identity the plugin uses for cache-key folding, ChainProbe
		 *  dispatch, etc. A plain string value: downstream lookups
		 *  (chain-probe / faucet capability keys) key on it directly. */
		readonly chain: string;
		/** Source provenance for renderer display. */
		readonly source?: 'cli' | 'env' | 'config' | 'default';
	} & DevstackNetworkModeRegistry[Mode]
>;

/** Default network shape used when nothing is pinned. */
export type DefaultNetwork = NetworkConfig<'local'>;
