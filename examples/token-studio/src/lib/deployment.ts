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
// `coins.managed_coin.{fullCoinType, packageId}` are emitted by the generated
// (stack-free) coin table; the discovery-only object ids (`treasuryCapId` /
// `metadataId`) are NON-DETERMINISTIC — they are only known after a live
// publish, so the committed table omits them and they are resolved at runtime
// from the injected ids' generic `values` channel (`coin:managed_coin`). The
// generated key follows the witness struct name.

import { coins } from '@generated/coins.js';
import { resolveValueOptional } from '@generated/config-runtime.js';

const studio = coins.managed_coin;

// Resolve a discovery-only coin object id from the injected ids, tolerating
// absence: a build with no injected ids (or a coin not yet published) yields
// `''`, which the UI gates on (`isDeployed`, query `enabled`). The non-throwing
// `resolveValueOptional` returns `undefined` for these optional ids; the hard
// `DevstackConfigMissingError` from the typed resolvers stays loud for the
// load-bearing fields (rpc, package ids).
const discoveryId = (key: string): string =>
	resolveValueOptional<string>('coin:managed_coin', key) ?? '';

export const deployment = {
	// Display-only: the published package id (header/footer + deployed gate).
	packageId: studio?.packageId ?? '0x0',
	// Coin TYPE string — sourced from generated coin config, never concatenated.
	managedCoinType: studio?.fullCoinType ?? '',
	// Known objects, sourced from coin auto-discovery (runtime-resolved).
	treasuryCapId: discoveryId('treasuryCapId'),
	metadataId: discoveryId('metadataId'),
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
