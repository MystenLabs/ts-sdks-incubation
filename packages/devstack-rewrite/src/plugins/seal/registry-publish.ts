// Seal plugin — admin / known-deploy tag fan-out.
//
// Distilled-doc invariant: the local-keygen mode produces BOTH the
// read-side handle (server configs + URL + object id) AND the
// local-only admin handle (master-key envfile + rotate). The
// known-deployment modes produce ONLY the read-side handle (we
// don't own the master key for a remote deployment, so there's no
// manager surface). Distilled-doc §Hard requirements #15.
//
// This file is the SINGLE OWNER of the tag fan-out. It declares
// the two resolved shapes + the tag-id constructors, and exports a
// helper to project a local-keygen-resolved state into either tag's
// shape (so the lifecycle row's resolved value can be projected
// downstream by either narrow tag).
//
// Tag ids:
//
//   - `seal:<name>`           — read-side tag (always produced).
//   - `seal-manager:<name>`   — admin tag (local-keygen mode only).
//
// The `<name>` suffix lets multiple seal instances coexist in a stack
// without colliding on the tag registry (distilled doc §Pain Points
// #7 — multi-instance currently untested but structurally supported).

import { defineTag } from '../../api/tag.ts';
import type { SealKeyManager } from './key-manager.ts';

// ---------------------------------------------------------------------------
// Read-side: SealKeyServer
// ---------------------------------------------------------------------------

/** Structural mirror of `@mysten/seal`'s `KeyServerConfig`.
 *
 *  Distilled-doc invariant #9 + #18: peer-dep structural
 *  assignability. `@mysten/seal` is a peer dep — we duplicate the
 *  shape locally to keep the runtime import off the bundle. A
 *  compile-time `_SealKeyServerEntryCheck` (in `composite.ts`)
 *  guards against drift. */
export interface SealKeyServerEntry {
	readonly objectId: string;
	readonly weight: number;
	readonly aggregatorUrl?: string;
}

/** Read-side resolved value. SDK-ready: pass `serverConfigs` to
 *  `new SealClient({serverConfigs, ...})` directly. */
export interface SealKeyServer {
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
	readonly keyServerUrl: string;
	readonly objectId: string;
}

/** Tag id constructor for the read-side handle. */
export type SealTagId<Name extends string> = `seal:${Name}`;
export const sealTagId = <Name extends string>(name: Name): SealTagId<Name> => `seal:${name}`;

/** Construct the read-side tag. */
export const makeSealTag = <Name extends string>(name: Name) =>
	defineTag<SealTagId<Name>, SealKeyServer>(sealTagId(name), 'seal');

// ---------------------------------------------------------------------------
// Admin: SealKeyManager — local-keygen mode ONLY
// ---------------------------------------------------------------------------

/** Tag id constructor for the admin handle. The `seal-manager:`
 *  prefix is distinct from `seal:` so the substrate's tag registry
 *  can dedup the two cleanly. */
export type SealManagerTagId<Name extends string> = `seal-manager:${Name}`;
export const sealManagerTagId = <Name extends string>(name: Name): SealManagerTagId<Name> =>
	`seal-manager:${name}`;

/** Construct the admin tag. */
export const makeSealManagerTag = <Name extends string>(name: Name) =>
	defineTag<SealManagerTagId<Name>, SealKeyManager>(sealManagerTagId(name), 'seal');

// ---------------------------------------------------------------------------
// Projection helpers — narrow the composite's resolved value
// ---------------------------------------------------------------------------

/** Aggregate resolved value the composite's acquire body returns.
 *  Distilled-doc §"SealLocalKeygenInternalShape" — `{keyServer,
 *  keyManager, packageId}`. Modes that don't own a manager omit it. */
export interface SealLocalKeygenResolved {
	readonly keyServer: SealKeyServer;
	readonly keyManager: SealKeyManager;
	readonly packageId: string;
}

export interface SealKnownResolved {
	readonly keyServer: SealKeyServer;
}

/** Project the composite's aggregate to the read-side shape. */
export const toKeyServerProjection = (
	resolved: SealLocalKeygenResolved | SealKnownResolved,
): SealKeyServer => resolved.keyServer;

/** Project the composite's aggregate to the admin shape. Returns
 *  `null` for known-deployment modes (distilled-doc invariant #15). */
export const toKeyManagerProjection = (
	resolved: SealLocalKeygenResolved | SealKnownResolved,
): SealKeyManager | null => ('keyManager' in resolved ? resolved.keyManager : null);
