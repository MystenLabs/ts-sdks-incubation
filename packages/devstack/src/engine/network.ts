// resolveNetwork — single source of truth for which Sui network this
// devstack run is targeting. Read at factory-call time (NOT acquire
// time) by every network-aware factory (`Sui`, `Seal`, `Walrus`,
// `Deepbook`) so the user's config composes the same Refs regardless
// of network — the factory body branches internally.
//
// Resolution order:
//   1. `DEVSTACK_NETWORK` env var (`'localnet' | 'testnet' | 'mainnet'`).
//   2. `'localnet'` default.
//
// The CLI sets `DEVSTACK_NETWORK` from its `--network` flag BEFORE
// dynamic-importing the user's `devstack.config.ts`, so every factory
// call inside the config sees the same value.
//
// User code that wants to pin a network programmatically can either:
//   - set `process.env.DEVSTACK_NETWORK = 'testnet'` at the top of
//     `devstack.config.ts` (before any factory call), or
//   - pass an explicit `Sui({ network: { rpc, faucet } })` for custom
//     RPCs (corporate fullnodes, pinned forks).

import type { SuiNetwork } from '../services/sui.js';

const KNOWN_NETWORKS: ReadonlyArray<SuiNetwork> = ['localnet', 'testnet', 'mainnet'];

/** Resolve the target Sui network from the environment. Returns
 *  `'localnet'` as the default when `DEVSTACK_NETWORK` is unset or
 *  unrecognized. */
export const resolveNetwork = (): SuiNetwork => {
	const raw = process.env.DEVSTACK_NETWORK;
	if (raw === undefined) return 'localnet';
	const normalized = raw.trim().toLowerCase() as SuiNetwork;
	if (KNOWN_NETWORKS.includes(normalized)) return normalized;
	throw new Error(
		`DEVSTACK_NETWORK="${raw}" is not a recognized Sui network. ` +
			`Expected one of: ${KNOWN_NETWORKS.join(', ')}.`,
	);
};

/** Whether the current network is a live network (anything other than
 *  localnet). Composite factories use this to decide whether to boot
 *  local infra or wire to the canonical remote deployment. */
export const isLiveNetwork = (network: SuiNetwork): boolean => network !== 'localnet';
