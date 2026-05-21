// Sui plugin — NetworkResolver contribution.
//
// Architecture §5: every plugin reads ONE resolver per acquire. Sui
// is special: it's the resolver source-of-truth for the chain
// identity that downstream plugins fold into their cache keys. This
// file emits the `NetworkConfig` value from the plugin's resolved
// mode + the resolved chain id; the substrate stamps it into
// `BuildContext` for downstream acquires.
//
// Mode → `NetworkConfig.mode` mapping:
//
//   - `local`    → `mode: 'local'`
//   - `external` → `mode: 'local'` (the chain itself is still
//                   local in semantics — caller wrapped their own
//                   localnet; downstream plugins shouldn't branch
//                   on container-vs-external below the resolver).
//   - `live`     → `mode: 'live'`
//   - `fork`     → `mode: 'fork'` — and the resolver SHALL emit the
//                   upstream's REAL chain id, not a fork-local
//                   digest, so wallet-standard / MVR / known-package
//                   lookups work.

import { Effect } from 'effect';

import type { NetworkResolver, NetworkResolutionError } from '../../contracts/network-resolver.ts';
import type { NetworkConfig, NetworkMode } from '../../substrate/network.ts';
import type { ChainId } from '../../substrate/brand.ts';
import type { SuiPluginMode } from './mode/spec.ts';

/** Plugin-internal shape — the resolved mode's identity, populated
 *  by the mode-specific builder. The resolver below projects this
 *  into the substrate's `NetworkConfig`. */
export interface ResolvedSuiNetwork {
	readonly mode: SuiPluginMode;
	/** Branded chain identity — assembled by the mode builders so
	 *  downstream lookups (chain-probe / faucet capability keys) and
	 *  the `NetworkConfig` projection both accept it without a re-wrap. */
	readonly chain: ChainId;
	readonly rpc: string;
	readonly faucet?: string;
	readonly graphql?: string;
	readonly source: 'cli' | 'env' | 'config' | 'default';
	/** Fork-only: upstream + checkpoint pin. */
	readonly checkpoint?: string;
	readonly forkUpstream?: 'mainnet' | 'testnet' | 'devnet';
}

/** Map the plugin's mode discriminator to the substrate's closed
 *  `NetworkMode` set. */
const toSubstrateMode = (mode: SuiPluginMode): NetworkMode => {
	switch (mode) {
		case 'local':
		case 'external':
			return 'local';
		case 'live':
			return 'live';
		case 'fork':
			return 'fork';
	}
};

/** Construct the substrate's `NetworkResolver` from the plugin's
 *  resolved network. One resolution per acquire, threaded as
 *  Context to downstream plugins. */
export const makeSuiNetworkResolver = (resolved: ResolvedSuiNetwork): NetworkResolver => {
	const config: NetworkConfig = {
		mode: toSubstrateMode(resolved.mode),
		chain: resolved.chain,
		rpc: resolved.rpc,
		source: resolved.source,
		...(resolved.checkpoint !== undefined ? { checkpoint: resolved.checkpoint } : {}),
	};
	return {
		resolve: Effect.succeed(config) as Effect.Effect<NetworkConfig, NetworkResolutionError>,
	};
};
