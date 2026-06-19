// App-level projection of the devstack manifest. Pulls the shapes the UI
// cares about — the published managed_coin's known objects and its fully
// qualified coin type — out of the generated stack handles
// (`@generated/coins.js`) so app code never touches the raw manifest.
//
// Package RESOLUTION for Move calls is handled by MVR: the generated bindings
// default their `package` to `@local/managed_coin`, which the client resolves
// via the `mvr.overrides` wired in `dapp-kit.ts`. So this projection carries
// only KNOWN OBJECTS (the TreasuryCap) and the coin TYPE string — both of
// which come straight from coin auto-discovery, never from package-id
// concatenation. The `packageId` below is kept purely for display (header /
// footer) and the "is anything deployed?" gate.
//
// NOTE: the account directory the UI renders (alice/bob/carol in DEV) is NOT
// part of this prod-path projection — it is read from the CONNECTED WALLET
// via dApp Kit (`useCurrentWallet().accounts`), so it reflects whatever
// accounts the active wallet exposes in any build.
//
// `coins.forNetwork(net).managed_coin.{fullCoinType, packageId}` are emitted by
// the generated (stack-free) coin table; the discovery-only object ids
// (`treasuryCapId` / `metadataId`) are NON-DETERMINISTIC — they are only known
// after a live publish, so the committed table omits them and they are resolved
// at runtime from the injected ids' generic `values` channel
// (`coin:managed_coin`). The generated key follows the witness struct name.
//
// Everything is keyed by NETWORK: `deploymentForNetwork(net)` projects one
// network, and the `useDeployment()` hook binds that to the dapp-kit-selected
// network so a runtime `switchNetwork` re-projects all coin ids in lockstep.

import { useCurrentNetwork } from '@mysten/dapp-kit-react';

import { coins } from '@generated/coins.js';
import { config } from '@generated/config.js';
import { optionalValue } from '@generated/config-runtime.js';

// Project the manifest for ONE network. Both the generated coin table
// (`coins.forNetwork`) and the discovery-only object ids resolve per network,
// so flipping the dapp-kit-selected network (via `useDeployment`) flips every
// coin id in lockstep — a runtime `switchNetwork` re-projects everything.
export function deploymentForNetwork(network: string) {
	const studio = coins.forNetwork(network).managed_coin;
	const net = config.forNetwork(network);

	// Resolve a discovery-only coin object id off this network's deployment,
	// tolerating absence: a build with no injected ids (or a coin not yet
	// published) yields `''`, which the UI gates on (`isDeployedFor`, query
	// `enabled`). The non-throwing `optionalValue` returns `undefined` for these
	// optional ids; the hard `DevstackConfigMissingError` from `requireValue`
	// stays loud for the load-bearing fields (rpc, package ids).
	const discoveryId = (key: string): string =>
		optionalValue<string>(net, 'coin:managed_coin', key) ?? '';

	return {
		// Display-only: the published package id (header/footer + deployed gate).
		packageId: studio?.packageId ?? '0x0',
		// Coin TYPE string — sourced from generated coin config, never concatenated.
		managedCoinType: studio?.fullCoinType ?? '',
		// Known objects, sourced from coin auto-discovery (runtime-resolved).
		treasuryCapId: discoveryId('treasuryCapId'),
		metadataId: discoveryId('metadataId'),
	} as const;
}

export type Deployment = ReturnType<typeof deploymentForNetwork>;

export const isDeployedFor = (d: Deployment): boolean => (d.packageId as string) !== '0x0';

/**
 * The active deployment, projected for the dapp-kit-selected network. Because
 * the network comes from `useCurrentNetwork()`, a runtime `switchNetwork` flips
 * the coin ids/type this returns, and every consumer hook re-reads in lockstep.
 */
export function useDeployment(): Deployment {
	return deploymentForNetwork(useCurrentNetwork());
}
