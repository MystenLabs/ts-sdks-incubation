// Resolve a CLI `--target` value (or fallback) into a concrete
// `ResolvedTarget` (network, stack, rpcUrl). Used by `devstack deploy`
// today, `devstack apply` / `devstack codegen` once those land.
//
// Target string forms:
//   - `<network>:<stack>` — unambiguous; live nets ignore the stack and
//     fall back to `DEFAULT_STACK`.
//   - bare network (`localnet|testnet|mainnet`) — stack from CLI flag /
//     active-stack pointer for localnet; `DEFAULT_STACK` for live nets.
//   - bare stack — implicit `localnet`.
//
// Errors fast on unrecognized network prefixes so a typo like
// `--target tetnet` doesn't silently degrade to a "stack" lookup.

import type { DevstackConfig, Network, ResolvedTarget } from '../core/types.js';
import { DEFAULT_STACK, resolveStack } from '../runtime/active-stack.js';
import { resolveNetworkProfile } from './network-profile.js';

const NETWORKS: ReadonlyArray<Network> = ['localnet', 'testnet', 'mainnet'];

interface ResolveTargetOptions {
	config: DevstackConfig;
	appDir: string;
	/** Raw `--target` value (or undefined when no flag was passed). */
	raw?: string | undefined;
	/** Fallback network when `raw` is undefined. Defaults to `'localnet'`. */
	fallbackNetwork?: Network;
	/** Fallback stack-name flag when `raw` is undefined. Forwarded to
	 * `resolveStack({ flag })` so `--stack` overrides take effect. */
	fallbackStack?: string | undefined;
}

export function resolveTarget(opts: ResolveTargetOptions): ResolvedTarget {
	if (opts.raw !== undefined && opts.raw.length > 0) {
		return parseTargetString(opts.raw, opts);
	}
	const network: Network = opts.fallbackNetwork ?? 'localnet';
	const stack =
		network === 'localnet'
			? resolveStack({ appDir: opts.appDir, flag: opts.fallbackStack })
			: DEFAULT_STACK;
	return { network, stack, rpcUrl: pickRpcUrl(opts.config, network) };
}

function parseTargetString(raw: string, opts: ResolveTargetOptions): ResolvedTarget {
	if (raw.includes(':')) {
		const idx = raw.indexOf(':');
		const head = raw.slice(0, idx);
		const tail = raw.slice(idx + 1);
		if (!isNetwork(head)) {
			throw new Error(
				`--target '${raw}': unknown network '${head}' — expected localnet|testnet|mainnet`,
			);
		}
		const network = head;
		const stack = network === 'localnet' && tail.length > 0 ? tail : DEFAULT_STACK;
		return { network, stack, rpcUrl: pickRpcUrl(opts.config, network) };
	}
	if (isNetwork(raw)) {
		const stack = raw === 'localnet' ? resolveStack({ appDir: opts.appDir }) : DEFAULT_STACK;
		return { network: raw, stack, rpcUrl: pickRpcUrl(opts.config, raw) };
	}
	// Bare value that isn't a network — interpret as a localnet stack name.
	return {
		network: 'localnet',
		stack: raw,
		rpcUrl: pickRpcUrl(opts.config, 'localnet'),
	};
}

function isNetwork(value: string): value is Network {
	return NETWORKS.includes(value as Network);
}

/** Localnet's RPC URL isn't known until the sui plugin's Service action
 * registers it; return an empty string in that case so callers can detect
 * the absence and fall back to a manifest-derived URL (see cli/console.ts).
 * Live-net targets without a declared `rpcUrl` throw via
 * `resolveNetworkProfile`. */
function pickRpcUrl(config: DevstackConfig, network: Network): string {
	const declared = config.networks?.[network];
	if (declared !== undefined) return declared;
	if (network === 'localnet') return '';
	return resolveNetworkProfile(config, network).rpcUrl;
}
