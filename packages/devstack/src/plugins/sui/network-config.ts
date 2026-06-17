// Network mode discriminator + network record. A SUI-PLUGIN DOMAIN
// concept (mode/chain/rpc/faucet/graphql), NOT a substrate primitive:
// the substrate is name-blind and knows nothing about chains or network
// modes. The sui node produces a `NetworkConfig`; sui-dependent nodes
// (walrus/seal/deepbook/package/account) consume it as a resolved dep
// value. The authoring surface (`defineDevstackWith` / `suiFor`) narrows
// the mode at the type level.

/** Network mode registry. Architecture: fork is a network mode, not
 *  an orchestrator. Module augmentation can add modes without widening
 *  every config field. */
export interface DevstackNetworkModeRegistry {
	readonly local: { readonly rpc?: string };
	readonly live: { readonly rpc?: string };
	readonly fork: { readonly rpc?: string; readonly checkpoint?: string };
}

export type NetworkMode = keyof DevstackNetworkModeRegistry & string;

/** Sui-plugin network record. Plugin-author factories that take
 *  `(network)` read this as the resolved mode-narrow value — one value
 *  per acquire. */
export type NetworkConfig<Mode extends NetworkMode = NetworkMode> = Readonly<
	{
		readonly mode: Mode;
		/** Genesis-digest chain identifier (the node's real chain id, fetched
		 *  via `fetchChainId`) the plugin folds into cache keys + `ChainProbe`
		 *  / faucet capability keys — unique per spun-up network so two
		 *  same-named localnets never share a cache namespace. NOT the network
		 *  name (that is the substrate `Identity.network`). */
		readonly chainId: string;
		/** Source provenance for renderer display. */
		readonly source?: 'cli' | 'env' | 'config' | 'default';
	} & DevstackNetworkModeRegistry[Mode]
>;

/** Default network shape used when nothing is pinned. */
export type DefaultNetwork = NetworkConfig<'local'>;
