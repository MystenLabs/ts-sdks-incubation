// Interface contracts for Seal.
//
// Phase 6c will introduce factories that produce only the network-side
// view of a Seal deployment (e.g. `sealTestnet` knows a key-server's
// object id + URL but has no master key, no rotation capability). The
// current `primitives/seal.ts` collapses everything into one shape; we
// split along the capability axis so consumers can write their
// dependencies precisely.

import { Context, Effect, Schema } from 'effect';
import { SealError } from '../primitives/errors.js';

// -----------------------------------------------------------------------------
// SealKeyServer — network-side view
// -----------------------------------------------------------------------------

/**
 * SDK-ready key-server config for a single seal key server. Mirrors
 * `@mysten/seal`'s `KeyServerConfig` structurally — duplicated here
 * rather than imported so `@mysten/seal` stays a peer dep. Multiple
 * entries are aggregated into `SealKeyServerShape.serverConfigs`.
 *
 *  - `objectId` is the on-chain `KeyServer` object id (the local-keygen
 *    primitive exposes this as `keyServer.id`).
 *  - `weight` is the server's quorum weight. Local-deploy stacks publish
 *    a single server with weight 1; known-mode stacks default to 1 per
 *    entry today.
 *  - `apiKeyName` / `apiKey` are optional credentials for paid public
 *    key-servers (e.g. Mysten testnet's premium tier).
 *  - `aggregatorUrl` is an optional client-side override for the
 *    `@mysten/seal` aggregator endpoint.
 *
 *  Note: the BLS12-381 public key intentionally isn't on this shape —
 *  the upstream `@mysten/seal` client retrieves it dynamically from
 *  `<keyServerUrl>/v1/service`, so pinning a static value would be
 *  misleading. Consumers that need to verify signatures should fetch
 *  it from the server at runtime.
 */
export interface SealKeyServerEntry {
	readonly objectId: string;
	readonly weight: number;
	readonly apiKeyName?: string;
	readonly apiKey?: string;
	readonly aggregatorUrl?: string;
}

/** Network-side view every Seal-key-server factory must surface. */
export interface SealKeyServerShape {
	/**
	 * SDK-ready array of key-server configs. Pass directly to
	 * `new SealClient({ suiClient, serverConfigs: sealKeyServer.serverConfigs })`.
	 * Local-mode deploys publish a single server with weight 1; known-mode
	 * stacks may carry multiple (e.g. a t-of-n committee) when future
	 * options expand this surface.
	 */
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;

	/**
	 * Informational: the HTTP URL of the (first) key server. Useful for
	 * health checks + local debugging. The `@mysten/seal` client retrieves
	 * URLs dynamically from the on-chain `KeyServer` object, so this is a
	 * convenience field for the single-server local-deploy case rather
	 * than something the SDK consumes.
	 */
	readonly keyServerUrl: string;

	/**
	 * Convenience: the (first) server's objectId. Equivalent to
	 * `serverConfigs[0]?.objectId`. Kept on the top-level shape so callers
	 * that only care about identifying the single local server don't need
	 * to reach into the array.
	 */
	readonly objectId: string;
}

export class SealKeyServer extends Context.Service<SealKeyServer, SealKeyServerShape>()(
	'@devstack/SealKeyServer',
) {}

// -----------------------------------------------------------------------------
// SealKeyManager — local-only capabilities
// -----------------------------------------------------------------------------

/** Local-only Seal admin capabilities. Phase 6c's remote `sealTestnet`-
 *  style factories will NOT produce a `SealKeyManager` layer, so any
 *  code that depends on it is type-checked away from running against
 *  testnet/mainnet.
 *
 *  - `masterKeyEnvFile` is the path to the 0o600-perm env-file the
 *    primitive stages the master key in. Surfaced so tooling (key
 *    rotation, backups) can read it without re-deriving the path from
 *    state-dir conventions.
 *  - `rotate` regenerates the master key, re-registers the key server
 *    on chain, and re-stages the env-file. Implementations may
 *    short-circuit if the underlying cache is fresh. */
export interface SealKeyManagerShape {
	readonly masterKeyEnvFile: string;
	readonly rotate: Effect.Effect<void, SealError>;
}

export class SealKeyManager extends Context.Service<SealKeyManager, SealKeyManagerShape>()(
	'@devstack/SealKeyManager',
) {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** Runtime-validation mirror of `SealKeyServerShape`. Use
 *  `Schema.decode(SealKeyServerShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(SealKeyServer, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const SealKeyServerEntrySchema = Schema.Struct({
	objectId: Schema.String,
	weight: Schema.Number,
	apiKeyName: Schema.optional(Schema.String),
	apiKey: Schema.optional(Schema.String),
	aggregatorUrl: Schema.optional(Schema.String),
});

export const SealKeyServerShapeSchema = Schema.Struct({
	serverConfigs: Schema.Array(SealKeyServerEntrySchema),
	keyServerUrl: Schema.String,
	objectId: Schema.String,
});

// `SealKeyManagerShape` carries an Effect value (`rotate`) which isn't
// Schema-validatable; omit a Schema mirror — manager layers are always
// produced in-process and never round-trip through serialization.
