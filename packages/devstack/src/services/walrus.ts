// Walrus(opts?) — canonical Walrus factory. Picks local-cluster (full
// node committee + aggregator/publisher + on-chain registration) when
// the resolved network is localnet, and the canonical remote
// deployment (read-only handle pointing at the public Walrus network)
// on testnet/mainnet. Network is resolved from `DEVSTACK_NETWORK`
// (set by the CLI `--network` flag).
//
// This file also carries the **WalrusNetworkTag** / **WalrusNodesTag** /
// **WalrusProxyTag** / **WalrusAdminTag** Context.Service tags, split along
// the capability axis so future remote factories can produce a strict
// subset (`WalrusNetworkTag + WalrusProxyTag` for blob uploads;
// `+ WalrusAdminTag` for cluster-side capabilities).

import { Context, Effect, Schema } from 'effect';
import {
	walrusKnownDeployment,
	walrusLocalCluster,
	type WalrusKnownDeploymentOptions,
	type WalrusLocalClusterOptions,
} from './walrus/index.js';
import { WalrusError } from '../engine/errors.js';
import { resolveNetwork } from '../engine/network.js';
import { resolveDeploymentNetwork } from '../engine/known-deployments.js';
import { makeService } from '../advanced/make-service.js';
import type { StackMember } from '../engine/supervisor.js';

// Plugin authors who need to pin a private Walrus deployment can call
// `walrusKnownDeployment({...})` directly from `/advanced` — the
// canonical-only `Walrus()` factory intentionally exposes no `override:`
// surface (Wave 3 / §10.3): the canonical registry already carries every
// field for `testnet` / `mainnet`, and zero examples or tests ever set
// an override.

// -----------------------------------------------------------------------------
// WalrusNetworkTag — on-chain identifiers
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
 *  - `exchangeIds` carries WAL exchange contracts when the network
 *    exposes them — testnet today, mainnet does not.
 */
export interface WalrusNetwork {
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
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

export class WalrusNetworkTag extends Context.Service<WalrusNetworkTag, WalrusNetwork>()(
	'@devstack/WalrusNetworkTag',
) {}

// -----------------------------------------------------------------------------
// WalrusNodesTag — storage-node committee
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
export interface WalrusNodes {
	readonly nodes: ReadonlyArray<WalrusNodeInfo>;
}

export class WalrusNodesTag extends Context.Service<WalrusNodesTag, WalrusNodes>()(
	'@devstack/WalrusNodesTag',
) {}

// -----------------------------------------------------------------------------
// WalrusProxyTag — aggregator/publisher endpoints
// -----------------------------------------------------------------------------

/** Walrus aggregator + publisher URLs. The local primitive collapses
 *  both onto a single nginx vhost (`aggregatorUrl === publisherUrl`);
 *  remote factories may surface distinct endpoints, so the contract
 *  keeps them separate.
 *
 *  `proxyUrl` is the "front door" URL — what a SDK client should dial
 *  by default. For the local primitive it's identical to the
 *  aggregator/publisher URLs. */
export interface WalrusProxy {
	readonly proxyUrl: string;
	readonly aggregatorUrl: string;
	readonly publisherUrl: string;
}

export class WalrusProxyTag extends Context.Service<WalrusProxyTag, WalrusProxy>()(
	'@devstack/WalrusProxyTag',
) {}

// -----------------------------------------------------------------------------
// WalrusAdminTag — local-only capabilities
// -----------------------------------------------------------------------------

/** Capabilities only available when WE booted the cluster. Remote
 *  `walrusKnownDeployment`-style factories will NOT produce a
 *  `WalrusAdminTag` layer, so any code that depends on it is type-checked
 *  away from running against testnet/mainnet.
 *
 *  - `waitForCommittee` blocks until every storage node passes its
 *    ready probe. Useful for downstream primitives that submit blobs
 *    immediately after boot.
 *  - `seedWal` swaps SUI for WAL on the named account via the
 *    on-chain `wal_exchange::exchange_all_for_wal` Move call. Mirrors
 *    the current primitive's `seedWalForAccounts` helper. */
export interface WalrusAdmin {
	readonly waitForCommittee: Effect.Effect<void, WalrusError>;
	readonly seedWal: (account: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<void, WalrusError>;
}

export class WalrusAdminTag extends Context.Service<WalrusAdminTag, WalrusAdmin>()(
	'@devstack/WalrusAdminTag',
) {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** Runtime-validation mirror of `WalrusNetwork`. Use
 *  `Schema.decode(WalrusNetworkSchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusNetworkTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusNetworkSchema = Schema.Struct({
	systemObjectId: Schema.String,
	stakingPoolId: Schema.String,
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

/** Runtime-validation mirror of `WalrusNodes`. Use
 *  `Schema.decode(WalrusNodesSchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusNodesTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusNodesSchema = Schema.Struct({
	nodes: Schema.Array(WalrusNodeInfoSchema),
});

/** Runtime-validation mirror of `WalrusProxy`. Use
 *  `Schema.decode(WalrusProxySchema)` to validate a hand-rolled
 *  `Layer.succeed(WalrusProxyTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const WalrusProxySchema = Schema.Struct({
	proxyUrl: Schema.String,
	aggregatorUrl: Schema.String,
	publisherUrl: Schema.String,
});

// `WalrusAdmin` carries Effect values which aren't Schema-validatable;
// omit a Schema mirror — admin layers are always produced in-process and
// never round-trip through serialization.

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export interface WalrusOptions {
	/** Pass-through extras for the local-cluster path. Ignored on
	 *  testnet/mainnet (the canonical Walrus deployment is already
	 *  running). */
	readonly local?: WalrusLocalClusterOptions;
}

/** Walrus factory. Picks the local-cluster path on localnet and the
 *  canonical remote deployment on testnet/mainnet — single source of
 *  truth is `DEVSTACK_NETWORK` (set by the CLI `--network` flag or via
 *  `devstack({ network })`). Returns a LayeredTag carrying the network +
 *  proxy contracts.
 *
 *  Fork mode (Phase 3, D5): when the resolved network is a `*-fork`
 *  variant, routes to `walrusKnownDeployment` against the WRAPPED
 *  upstream's real Walrus deployment. The local-cluster path requires
 *  GraphQL + JSON-RPC against the chain (which sui-fork does not
 *  expose), so it's not a viable option on fork stacks; explicit
 *  `walrusLocalCluster()` composition under fork mode trips a
 *  structured `ForkIncompatibleError` at factory time. */
export const Walrus = (opts: WalrusOptions = {}): StackMember => {
	const network = resolveNetwork();
	if (network !== 'localnet') {
		// `network` is one of `testnet | mainnet | *-fork`. Fork variants
		// resolve to their upstream's `KnownNetwork` key via
		// `resolveDeploymentNetwork`; live nets pass through. Plugin
		// authors needing to pin a private deployment reach for
		// `walrusKnownDeployment({...})` on `/advanced` directly.
		const knownNetwork = resolveDeploymentNetwork(network);
		const knownOpts: WalrusKnownDeploymentOptions =
			knownNetwork !== undefined ? { network: knownNetwork } : {};
		return makeService('walrus', 'service', walrusKnownDeployment(knownOpts));
	}
	return makeService('walrus', 'service', walrusLocalCluster(opts.local ?? {}));
};

// `localnetWalrusOptions(args)` — pure-function helper that builds the
// `packageConfig` + `storageNodeUrlScheme: 'http'` fields for
// `new WalrusClient(...)` against a devstack-booted walrus. Browser
// code in example apps sources the ids from the generated `captured.ts`
// and passes them in directly.
export {
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusInputs,
} from './walrus/options.js';
