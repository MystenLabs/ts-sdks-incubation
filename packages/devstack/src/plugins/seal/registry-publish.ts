// Seal plugin — public resolved value.
//
// Tag ids:
//
//   - `seal:<name>` — read-side key-server fields plus the local-only
//                     manager handle when the stack owns the master key.
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

/** Public Seal resolved value. The key-server fields stay top-level
 *  so the direct member ref is immediately SDK-ready; local-keygen
 *  additionally exposes `manager`, while known deployments set it to
 *  `null` because this stack does not own the master key. */
export interface SealResolved extends SealKeyServer {
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
	readonly manager: SealKeyManager | null;
}

/** Tag id constructor for the read-side handle. */
export type SealTagId<Name extends string> = `seal:${Name}`;
export const sealTagId = <Name extends string>(name: Name): SealTagId<Name> => `seal:${name}`;

/** Construct the read-side tag. */
export const makeSealTag = <Name extends string>(name: Name) =>
	defineTag<SealTagId<Name>, SealResolved>(sealTagId(name), 'seal');

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
