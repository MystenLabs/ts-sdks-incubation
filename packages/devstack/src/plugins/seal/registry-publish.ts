// Seal plugin — public resolved value.
//
// Resource ids:
//
//   - `seal:<name>` — read-side key-server fields plus the local-only
//                     manager handle when the stack owns the master key.
//
// The `<name>` suffix lets multiple seal instances coexist in a stack
// without colliding on the resource registry (distilled doc §Pain Points
// #7 — multi-instance currently untested but structurally supported).

import type { KeyServerConfig } from '@mysten/seal';

import { resource } from '../../api/define-plugin.ts';
import type { SealKeyManager } from './key-manager.ts';

// ---------------------------------------------------------------------------
// Read-side: SealKeyServer
// ---------------------------------------------------------------------------

/** Structural mirror of `@mysten/seal`'s `KeyServerConfig`.
 *
 *  Distilled-doc invariant #9 + #18: peer-dep structural
 *  assignability. `@mysten/seal` is a peer dep — we duplicate the
 *  shape locally to keep the runtime import off the bundle (the
 *  `import type` above erases at compile time). The committee path
 *  needs `aggregatorUrl` (all fetch-key calls route through the
 *  aggregator) and, on mainnet, the API-key pair (`apiKeyName` +
 *  `apiKey`); independent servers use just `{objectId, weight}`. The
 *  `_drift` assertion below guards against the SDK shape changing
 *  underneath us. */
export interface SealKeyServerEntry {
	readonly objectId: string;
	readonly weight: number;
	readonly apiKeyName?: string;
	readonly apiKey?: string;
	readonly aggregatorUrl?: string;
}

// ---------------------------------------------------------------------------
// Compile-time drift guard against `@mysten/seal`'s `KeyServerConfig`
// ---------------------------------------------------------------------------
//
// `import type { KeyServerConfig }` above is erased at compile time, so this
// guard adds NO runtime import. We mirror `KeyServerConfig` field-for-field;
// if the SDK adds/removes/renames a field (e.g. makes `apiKey` required), the
// mutual-extends `_AssertEq` collapses to `never` and this file fails to
// compile — surfacing the drift at our boundary instead of at the SDK call.

/** Strip `readonly` so our `readonly`-decorated mirror compares structurally
 *  equal to the SDK's mutable `KeyServerConfig`. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `true` iff `A` and `B` mutually extend (structurally equal); `never`
 *  otherwise — which makes the `const _drift: … = true` assignment below fail
 *  to typecheck, breaking the build on drift. */
type _AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _drift: _AssertEq<Mutable<SealKeyServerEntry>, KeyServerConfig> = true;
void _drift;

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

/** Resource id constructor for the read-side handle. */
export type SealResourceId<Name extends string> = `seal:${Name}`;
export const sealResourceId = <Name extends string>(name: Name): SealResourceId<Name> =>
	`seal:${name}`;

/** Construct the read-side resource. */
export const makeSealResource = <Name extends string>(name: Name) =>
	resource<SealResourceId<Name>, SealResolved>(sealResourceId(name));

// ---------------------------------------------------------------------------
// Projection helpers — narrow the plugin's resolved value
// ---------------------------------------------------------------------------

/** Aggregate resolved value the plugin's acquire body returns.
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
