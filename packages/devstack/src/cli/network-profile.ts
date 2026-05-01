// Resolve a live-network profile from `DevstackConfig.networks`. Throws an
// actionable error when the entry is missing — `devstack deploy` and
// future `devstack apply --target <network>` calls require an explicit
// rpcUrl since live nets don't have a local sui plugin to register one.

import type { DevstackConfig, Network } from '../core/types.js';

export interface NetworkProfile {
	rpcUrl: string;
}

export function resolveNetworkProfile(config: DevstackConfig, network: Network): NetworkProfile {
	const profile = config.networks?.[network];
	if (profile === undefined || profile.rpcUrl === undefined) {
		throw new Error(`config has no networks.${network}.rpcUrl — declare it in devstack.config.ts`);
	}
	return { rpcUrl: profile.rpcUrl };
}
