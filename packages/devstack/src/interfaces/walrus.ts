// Interface contracts for Walrus.
//
// The v3 / current `primitives/walrus.ts` produces a single composite
// `Walrus` shape lumping the on-chain package + storage-node committee
// + nginx proxy + admin capabilities together. That worked for "we
// always boot it ourselves", but Phase 6b will introduce factories
// that produce only part of the picture (e.g. `walrusTestnet` knows
// the system package id + an aggregator/publisher URL but has no
// committee under our control, no admin levers).
//
// We split the contract along the capability axis so future factories
// can produce a strict subset and downstream consumers can write their
// dependencies precisely (`R = WalrusNetwork | WalrusProxy` for "I just
// want to upload blobs", `R = ... | WalrusAdmin` for "I want to seed
// WAL").

import { Context, Effect, Schema } from 'effect';
import { WalrusError } from '../primitives/errors.js';

// -----------------------------------------------------------------------------
// WalrusNetwork — on-chain identifiers
// -----------------------------------------------------------------------------

/** Fields every Walrus-network-producing factory must surface. These
 *  are pure chain-state pointers (no host URLs, no admin capabilities),
 *  matching what `walrusKnownDeployment` can know without booting
 *  anything locally.
 *
 *  - `systemObjectId` is the on-chain Walrus System object id (NOT a
 *    Move package id). Matches `WalrusPackageConfig.systemObjectId` in
 *    the upstream `@mysten/walrus` SDK — the SDK derives the actual
 *    Move package from the system object's type via on-chain query, so
 *    we don't carry a separate `packageId`.
 *  - `stakingPoolId` is the on-chain staking-pool object id. The
 *    local-cluster primitive captures `stakingObject` from the deploy
 *    summary — same thing, renamed for the contract.
 *  - `subsidiesPackageId` is optional because localnet deploys don't
 *    register a subsidies package; testnet/mainnet may or may not.
 *  - `exchangeIds` carries WAL exchange contracts when the network
 *    exposes them — testnet today, mainnet does not.
 */
export interface WalrusNetworkShape {
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	readonly subsidiesPackageId: string | undefined;
	readonly exchangeIds: ReadonlyArray<string> | undefined;
	readonly network: 'localnet' | 'testnet' | 'mainnet' | (string & {});

	/**
	 * SDK-ready `WalrusPackageConfig` view. Pass directly to
	 * `new WalrusClient({ suiClient, packageConfig: walrusNetwork.packageConfig })`.
	 *
	 * The shape mirrors `@mysten/walrus`'s `WalrusPackageConfig`
	 * structurally; we duplicate it here rather than importing so
	 * `@mysten/walrus` stays a peer dep (consumers bring their own SDK
	 * version). `exchangeIds` is intentionally a mutable `string[]`
	 * (matching the SDK) so the value passes directly without a `[...x]`
	 * spread at the call site. A type-level shape-compatibility
	 * assertion lives in `src/primitives/walrus.test.ts`.
	 */
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: string[];
	};
}

export class WalrusNetwork extends Context.Service<WalrusNetwork, WalrusNetworkShape>()(
	'@devstack/WalrusNetwork',
) {}

// -----------------------------------------------------------------------------
// WalrusNodes — storage-node committee
// -----------------------------------------------------------------------------

/** Per-node descriptor. `nodeId` is the on-chain registered storage-
 *  node object id (or a synthetic stable identifier for known-network
 *  factories that don't have access to the registration). `publicKey`
 *  is the node's BLS public key (hex). `url` is the network-reachable
 *  endpoint each node exposes. */
export interface WalrusNodeInfo {
	readonly nodeId: string;
	readonly publicKey: string;
	readonly url: string;
}

/** Committee view. `walrusLocalDeploy` knows every node it spun up;
 *  `walrusTestnet`-style factories may surface an empty array when the
 *  set isn't enumerable. */
export interface WalrusNodesShape {
	readonly nodes: ReadonlyArray<WalrusNodeInfo>;
}

export class WalrusNodes extends Context.Service<WalrusNodes, WalrusNodesShape>()(
	'@devstack/WalrusNodes',
) {}

// -----------------------------------------------------------------------------
// WalrusProxy — aggregator/publisher endpoints
// -----------------------------------------------------------------------------

/** Walrus aggregator + publisher URLs. The local primitive collapses
 *  both onto a single nginx vhost (`aggregatorUrl === publisherUrl`);
 *  remote factories may surface distinct endpoints, so the contract
 *  keeps them separate.
 *
 *  `proxyUrl` is the "front door" URL — what a SDK client should dial
 *  by default. For the local primitive it's identical to the
 *  aggregator/publisher URLs. */
export interface WalrusProxyShape {
	readonly proxyUrl: string;
	readonly aggregatorUrl: string;
	readonly publisherUrl: string;
}

export class WalrusProxy extends Context.Service<WalrusProxy, WalrusProxyShape>()(
	'@devstack/WalrusProxy',
) {}

// -----------------------------------------------------------------------------
// WalrusAdmin — local-only capabilities
// -----------------------------------------------------------------------------

/** Capabilities only available when WE booted the cluster. Phase 6b's
 *  remote `walrusTestnet`-style factories will NOT produce a
 *  `WalrusAdmin` layer, so any code that depends on it is type-checked
 *  away from running against testnet/mainnet.
 *
 *  - `waitForCommittee` blocks until every storage node passes its
 *    ready probe. Useful for downstream primitives that submit blobs
 *    immediately after boot.
 *  - `seedWal` swaps SUI for WAL on the named account via the
 *    on-chain `wal_exchange::exchange_all_for_wal` Move call. Mirrors
 *    the current primitive's `seedWalForAccounts` helper. */
export interface WalrusAdminShape {
	readonly waitForCommittee: Effect.Effect<void, WalrusError>;
	readonly seedWal: (account: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void, WalrusError>;
}

export class WalrusAdmin extends Context.Service<WalrusAdmin, WalrusAdminShape>()(
	'@devstack/WalrusAdmin',
) {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** Runtime-validation mirror of `WalrusNetworkShape`. Use
 *  `Schema.decode(WalrusNetworkShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusNetwork, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusNetworkShapeSchema = Schema.Struct({
	systemObjectId: Schema.String,
	stakingPoolId: Schema.String,
	subsidiesPackageId: Schema.UndefinedOr(Schema.String),
	exchangeIds: Schema.UndefinedOr(Schema.Array(Schema.String)),
	network: Schema.String,
	packageConfig: Schema.Struct({
		systemObjectId: Schema.String,
		stakingPoolId: Schema.String,
		// Mutable array — matches the upstream `@mysten/walrus`
		// `WalrusPackageConfig.exchangeIds: string[]` so the decoded
		// value passes directly to `new WalrusClient(...)`.
		exchangeIds: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	}),
});

/** Runtime-validation mirror of `WalrusNodeInfo`. Use
 *  `Schema.decode(WalrusNodeInfoSchema)` to validate values
 *  round-tripped through JSON (e.g. manifest reads in tests). */
export const WalrusNodeInfoSchema = Schema.Struct({
	nodeId: Schema.String,
	publicKey: Schema.String,
	url: Schema.String,
});

/** Runtime-validation mirror of `WalrusNodesShape`. Use
 *  `Schema.decode(WalrusNodesShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusNodes, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusNodesShapeSchema = Schema.Struct({
	nodes: Schema.Array(WalrusNodeInfoSchema),
});

/** Runtime-validation mirror of `WalrusProxyShape`. Use
 *  `Schema.decode(WalrusProxyShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusProxy, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusProxyShapeSchema = Schema.Struct({
	proxyUrl: Schema.String,
	aggregatorUrl: Schema.String,
	publisherUrl: Schema.String,
});

// `WalrusAdminShape` carries Effect values which aren't Schema-validatable;
// omit a Schema mirror — admin layers are always produced in-process and
// never round-trip through serialization.
