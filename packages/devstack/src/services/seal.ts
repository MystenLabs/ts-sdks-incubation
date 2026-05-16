// Seal(opts?) — canonical Seal factory. Picks the local-keygen path
// (full container + master key + chain registration) when the resolved
// network is localnet, and the known-key-server path (read-only handle
// pointing at Mysten's public Seal deployment) on testnet/mainnet.
// The same config works against any network — the CLI `--network`
// flag flips this at runtime.
//
// This file also carries the **SealKeyServerTag** (network-side view) and
// **SealKeyManagerTag** (local-only admin capabilities) Context.Service
// tags, split along the capability axis so future remote factories can
// produce a strict subset of the surface.

import { Context, Effect, Schema } from 'effect';
import {
	sealKnownKeyServer,
	sealLocalKeygen,
	type SealKnownKeyServerOptions,
	type SealLocalKeygenOptions,
} from './seal/internal.js';
import { SealError } from '../engine/errors.js';
import { resolveNetwork } from '../engine/network.js';
import type { Account } from '../engine/shared.js';
import type { Ref } from '../advanced/tag.js';
import type { StackMember } from '../engine/supervisor.js';

// -----------------------------------------------------------------------------
// SealKeyServerTag — network-side view
// -----------------------------------------------------------------------------

/**
 * SDK-ready key-server config for a single seal key server. Mirrors
 * `@mysten/seal`'s `KeyServerConfig` structurally — duplicated here
 * rather than imported so `@mysten/seal` stays a peer dep. Multiple
 * entries are aggregated into `SealKeyServer.serverConfigs`.
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
export interface SealKeyServer {
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

export class SealKeyServerTag extends Context.Service<SealKeyServerTag, SealKeyServer>()(
	'@devstack/SealKeyServerTag',
) {}

// -----------------------------------------------------------------------------
// SealKeyManagerTag — local-only capabilities
// -----------------------------------------------------------------------------

/** Local-only Seal admin capabilities. Remote `sealKnownKeyServer`
 *  factories will NOT produce a `SealKeyManagerTag` layer, so any code
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
export interface SealKeyManager {
	readonly masterKeyEnvFile: string;
	readonly rotate: Effect.Effect<void, SealError>;
}

export class SealKeyManagerTag extends Context.Service<SealKeyManagerTag, SealKeyManager>()(
	'@devstack/SealKeyManagerTag',
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

/** Runtime-validation mirror of `SealKeyServer`. Use
 *  `Schema.decode(SealKeyServerSchema)` to validate a hand-rolled
 *  `Layer.succeed(SealKeyServerTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const SealKeyServerSchema = Schema.Struct({
	serverConfigs: Schema.Array(SealKeyServerEntrySchema),
	keyServerUrl: Schema.String,
	objectId: Schema.String,
});

// `SealKeyManager` carries an Effect value (`rotate`) which isn't
// Schema-validatable; omit a Schema mirror — manager layers are always
// produced in-process and never round-trip through serialization.

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export interface SealOptions {
	/** Signer used to publish the Seal Move package on localnet. Required
	 *  on localnet (where the local-keygen path runs); ignored on
	 *  testnet/mainnet (the canonical remote key server is already
	 *  deployed). */
	readonly signer?: Ref<any, Account, any, any>;
	/** Pass-through extras for the local-keygen path. Ignored when the
	 *  resolved network is testnet/mainnet. */
	readonly local?: Omit<SealLocalKeygenOptions<string>, 'name' | 'signer'>;
	/** Override the canonical key-server registry for testnet/mainnet.
	 *  Used when pinning to a private fork or a non-canonical deployment;
	 *  most users leave this unset and let the factory wire to
	 *  Mysten's public Seal deployment. */
	readonly override?: SealKnownKeyServerOptions;
	/** Override tag name. Defaults to `'seal'`. */
	readonly name?: string;
}

/** Seal factory. Picks local-keygen on localnet and the canonical
 *  remote key server on testnet/mainnet — single source of truth is
 *  `DEVSTACK_NETWORK` (set by the CLI `--network` flag or via
 *  `devstack({ network })`). Returns a Ref carrying
 *  `SealKeyServerTag`. */
export const Seal = (opts: SealOptions = {}): StackMember => {
	const network = resolveNetwork();
	if (network !== 'localnet') {
		// Remote path: wire to canonical (or user-overridden) deployment.
		const knownOpts: SealKnownKeyServerOptions = {
			network,
			...opts.override,
		};
		return Object.assign(sealKnownKeyServer(knownOpts), { __kind: 'service' as const });
	}
	// Local path: spin up our own key server. Signer publishes the Seal
	// Move package and pays the registration tx.
	if (opts.signer === undefined) {
		throw new Error(
			'Seal() on localnet requires a `signer:` ref to publish the Seal Move package. ' +
				'Pass an Account ref, or run with --network testnet / --network mainnet to use ' +
				'the canonical remote key server.',
		);
	}
	const localOpts: SealLocalKeygenOptions<string> = {
		signer: opts.signer,
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...opts.local,
	};
	return Object.assign(sealLocalKeygen(localOpts), { __kind: 'service' as const });
};
