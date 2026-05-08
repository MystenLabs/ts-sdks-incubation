// Resolve a live-network RPC URL from `DevstackConfig.networks`. Throws an
// actionable error when the entry is missing — `devstack apply --target
// <network>` calls require an explicit rpcUrl since live nets don't have
// a local sui plugin to register one.

import type { DevstackConfig, Network } from '../core/types.js';

interface NetworkProfile {
	rpcUrl: string;
}

/** Thrown when a CLI verb resolves to a live-network target whose
 * `networks.<network>` entry isn't declared in `devstack.config.ts`.
 * Caught by name (not `instanceof`) by every CLI's error-handling path
 * to surface a copy-paste config snippet without a stack trace. */
export class MissingNetworkProfileError extends Error {
	override readonly name = 'MissingNetworkProfileError';
	constructor(public readonly network: Network) {
		super(
			`config has no networks.${network} — declare it in devstack.config.ts:\n` +
				`\n` +
				`  defineDevstackConfig({\n` +
				`    networks: { ${network}: 'https://fullnode.${network}.sui.io:443' },\n` +
				`    // ...\n` +
				`  });\n`,
		);
	}
}

export function resolveNetworkProfile(config: DevstackConfig, network: Network): NetworkProfile {
	const rpcUrl = config.networks?.[network];
	if (rpcUrl === undefined) {
		throw new MissingNetworkProfileError(network);
	}
	return { rpcUrl };
}
