// Seal(opts?) — canonical Seal factory. Auto-picks the local-keygen
// path on localnet (full container + master key + chain registration)
// and the known-key-server path on testnet/mainnet (read-only handle
// pointing at Mysten's public Seal deployment).
//
// Mode override: `{ mode: 'local' }` or `{ mode: 'known' }` forces a
// specific path regardless of the surrounding network.
//
// This file also carries the **SealKeyServer** (network-side view) and
// **SealKeyManager** (local-only admin capabilities) Context.Service
// tags, split along the capability axis so future remote factories can
// produce a strict subset of the surface.

import { Context, Effect, Schema } from 'effect';
import {
	sealKnownKeyServer,
	sealLocalKeygen,
	type SealKnownKeyServerOptions,
	type SealLocalKeygenOptions,
} from '../primitives/seal.js';
import { SealError } from '../primitives/errors.js';
import type { Account } from '../primitives/shared.js';
import type { Ref } from '../advanced/tag.js';
import type { StackMember } from '../engine/supervisor.js';

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

/** Local-only Seal admin capabilities. Remote `sealKnownKeyServer`
 *  factories will NOT produce a `SealKeyManager` layer, so any code
 *  that depends on it is type-checked away from running against
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

/** Runtime-validation mirror of `SealKeyServerEntry`. */
export const SealKeyServerEntrySchema = Schema.Struct({
	objectId: Schema.String,
	weight: Schema.Number,
	apiKeyName: Schema.optional(Schema.String),
	apiKey: Schema.optional(Schema.String),
	aggregatorUrl: Schema.optional(Schema.String),
});

/** Runtime-validation mirror of `SealKeyServerShape`. Use
 *  `Schema.decode(SealKeyServerShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(SealKeyServer, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const SealKeyServerShapeSchema = Schema.Struct({
	serverConfigs: Schema.Array(SealKeyServerEntrySchema),
	keyServerUrl: Schema.String,
	objectId: Schema.String,
});

// `SealKeyManagerShape` carries an Effect value (`rotate`) which isn't
// Schema-validatable; omit a Schema mirror — manager layers are always
// produced in-process and never round-trip through serialization.

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export interface SealOptions {
	/** Which Seal source to use. `'auto'` (default) picks based on the
	 *  surrounding `Sui` network — local on localnet, known otherwise.
	 *  `'local'` forces the in-process keygen + container; `'known'`
	 *  forces a remote handle. */
	readonly mode?: 'auto' | 'local' | 'known';
	/** Signer used to publish the Seal Move package on the local-keygen
	 *  path. Required for `mode: 'local'` (or `'auto'` resolving to local).
	 *  Ignored on `mode: 'known'`. */
	readonly signer?: Ref<any, Account, any, any>;
	/** Pass-through extras for the local-keygen path. */
	readonly local?: Omit<SealLocalKeygenOptions<string>, 'name' | 'signer'>;
	/** Pass-through extras for the known-key-server path. */
	readonly known?: SealKnownKeyServerOptions;
	/** Override tag name. Defaults to `'seal'`. */
	readonly name?: string;
}

/** Resolve the seal mode from opts + ambient network. For Phase 2 the
 *  resolution is mode-only — once Phase 6 hooks default-resolution into
 *  `devstack(...)`, `'auto'` consults the merged Sui layer's network
 *  field. Until then `'auto'` defaults to `'local'`. */
const resolveMode = (opts: SealOptions): 'local' | 'known' => {
	if (opts.mode === 'local' || opts.mode === 'known') return opts.mode;
	return 'local';
};

/** Seal factory. Returns a Ref carrying the seal-key-server contract. */
export const Seal = (opts: SealOptions = {}): StackMember => {
	const mode = resolveMode(opts);
	if (mode === 'known') {
		return Object.assign(sealKnownKeyServer(opts.known ?? {}), { __kind: 'service' as const });
	}
	if (opts.signer === undefined) {
		throw new Error(
			'Seal({ mode: \'local\' }) requires a `signer:` ref. Pass an Account ref or switch to mode: \'known\'.',
		);
	}
	const localOpts: SealLocalKeygenOptions<string> = {
		signer: opts.signer,
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.local ?? {}),
	};
	return Object.assign(sealLocalKeygen(localOpts), { __kind: 'service' as const });
};
