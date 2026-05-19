// Manifest schema — single source of truth for the on-disk
// `.devstack/manifest.json` shape and every typed reader.
//
// The shape is organised as records keyed by name and sections grouped
// by user intent (`services`, `packages`, `accounts`, `app`, `coins`).
//
// Endpoints render as full traefik-routed hostnames (e.g.
// `http://sui.<app>.localhost:9000`) in the canonical `url` field. The
// optional `pairUrl` carries a paired form for callers that need a
// secondary URL alongside the primary (e.g. the wallet pairing URL with
// a `#token=` fragment). The TUI shows `url` only; the manifest
// serializes both.

import { Schema } from 'effect';

// -----------------------------------------------------------------------------
// Endpoint entry — the canonical { url, pairUrl? } shape used everywhere
// -----------------------------------------------------------------------------

/** A reachable URL plus an optional paired URL. The `pairUrl` is a
 *  typed secondary URL — used by the wallet endpoint to carry the
 *  `#token=<hex>` fragment without conflating "alternate hostnames" with
 *  "paired URL with auth payload" the way the prior `alternates` array
 *  did. */
export const EndpointEntry = Schema.Struct({
	url: Schema.String,
	pairUrl: Schema.optional(Schema.String),
});
export type EndpointEntry = typeof EndpointEntry.Type;

// -----------------------------------------------------------------------------
// Services section — { sui?, seal?, walrus?, deepbook? }
// -----------------------------------------------------------------------------

export const SuiManifest = Schema.Struct({
	network: Schema.String,
	chainId: Schema.optional(Schema.String),
	rpc: EndpointEntry,
	faucet: Schema.optional(EndpointEntry),
	graphql: Schema.optional(EndpointEntry),
	indexerDb: Schema.optional(EndpointEntry),
});
export type SuiManifest = typeof SuiManifest.Type;

export const SealManifest = Schema.Struct({
	keyServer: EndpointEntry,
	objectId: Schema.optional(Schema.String),
});
export type SealManifest = typeof SealManifest.Type;

export const WalrusManifest = Schema.Struct({
	aggregator: EndpointEntry,
	publisher: EndpointEntry,
	systemObjectId: Schema.optional(Schema.String),
});
export type WalrusManifest = typeof WalrusManifest.Type;

export const DeepbookPoolEntry = Schema.Struct({
	poolId: Schema.String,
	baseType: Schema.String,
	quoteType: Schema.String,
});
export type DeepbookPoolEntry = typeof DeepbookPoolEntry.Type;

export const DeepbookIndexerManifest = Schema.Struct({
	metrics: EndpointEntry,
});
export type DeepbookIndexerManifest = typeof DeepbookIndexerManifest.Type;

// DeepBook server. The REST endpoint (`rest`) is the consumer-facing
// surface (codegen-emitted into deepbook-config); the metrics endpoint
// mirrors the indexer's Prometheus shape.
export const DeepbookServerManifest = Schema.Struct({
	rest: EndpointEntry,
	metrics: EndpointEntry,
});
export type DeepbookServerManifest = typeof DeepbookServerManifest.Type;

// DeepBook margin. Captures the published margin + liquidation package
// ids, the MarginRegistry shared object, and the per-asset MarginPool
// object ids. `registeredPools` enumerates the deepbook pool ids the
// margin registry was told about (parity with sandbox's
// `register_deepbook_pool` calls).
export const DeepbookMarginPoolEntry = Schema.Struct({
	label: Schema.String,
	assetType: Schema.String,
	marginPoolId: Schema.String,
});
export type DeepbookMarginPoolEntry = typeof DeepbookMarginPoolEntry.Type;

export const DeepbookMarginManifest = Schema.Struct({
	packageId: Schema.String,
	liquidationPackageId: Schema.String,
	registryId: Schema.String,
	adminCapId: Schema.String,
	maintainerCapId: Schema.optional(Schema.String),
	marginPools: Schema.Array(DeepbookMarginPoolEntry),
	registeredPools: Schema.Array(Schema.String),
});
export type DeepbookMarginManifest = typeof DeepbookMarginManifest.Type;

export const DeepbookManifest = Schema.Struct({
	packageId: Schema.String,
	registryId: Schema.optional(Schema.String),
	pools: Schema.Record(Schema.String, DeepbookPoolEntry),
	indexer: Schema.optional(DeepbookIndexerManifest),
	server: Schema.optional(DeepbookServerManifest),
	margin: Schema.optional(DeepbookMarginManifest),
});
export type DeepbookManifest = typeof DeepbookManifest.Type;

export const PythPriceInfoEntry = Schema.Struct({
	label: Schema.String,
	feedId: Schema.String,
	priceInfoObjectId: Schema.String,
});
export type PythPriceInfoEntry = typeof PythPriceInfoEntry.Type;

export const PythManifest = Schema.Struct({
	packageId: Schema.String,
	pythStateId: Schema.optional(Schema.String),
	wormholeStateId: Schema.optional(Schema.String),
	/** Pyth feed-id (mainnet hex) → PriceInfoObject id. */
	priceInfoObjectIds: Schema.Record(Schema.String, Schema.String),
	/** Friendly label → feed-id. */
	feeds: Schema.Record(Schema.String, Schema.String),
});
export type PythManifest = typeof PythManifest.Type;

export const PostgresManifest = Schema.Struct({
	user: Schema.String,
	endpoint: EndpointEntry,
	containerNetwork: Schema.String,
	networkAlias: Schema.String,
	databases: Schema.Array(Schema.String),
	// `password` deliberately omitted — `groupPostgres` strips it.
});
export type PostgresManifest = typeof PostgresManifest.Type;

export const ServicesManifest = Schema.Struct({
	sui: Schema.optional(SuiManifest),
	seal: Schema.optional(SealManifest),
	walrus: Schema.optional(WalrusManifest),
	deepbook: Schema.optional(DeepbookManifest),
	pyth: Schema.optional(PythManifest),
	postgres: Schema.optional(PostgresManifest),
});
export type ServicesManifest = typeof ServicesManifest.Type;

// -----------------------------------------------------------------------------
// Packages section — record keyed by name
// -----------------------------------------------------------------------------

export const PackageEntry = Schema.Struct({
	id: Schema.String,
	upgradeCapId: Schema.optional(Schema.String),
	mvr: Schema.optional(Schema.String),
	captured: Schema.Record(Schema.String, Schema.Unknown),
});
export type PackageEntry = typeof PackageEntry.Type;

// -----------------------------------------------------------------------------
// Accounts section — record keyed by name
// -----------------------------------------------------------------------------

export const AccountEntry = Schema.Struct({
	address: Schema.String,
});
export type AccountEntry = typeof AccountEntry.Type;

// -----------------------------------------------------------------------------
// Coins section — record keyed by name
// -----------------------------------------------------------------------------

export const SdkCoinEntry = Schema.Struct({
	address: Schema.String,
	type: Schema.String,
	scalar: Schema.Number,
});
export type SdkCoinEntry = typeof SdkCoinEntry.Type;

export const CoinEntry = Schema.Struct({
	type: Schema.String,
	decimals: Schema.Number,
	sdkCoin: SdkCoinEntry,
	symbol: Schema.optional(Schema.String),
	displayName: Schema.optional(Schema.String),
	iconUrl: Schema.optional(Schema.String),
	treasuryCapId: Schema.optional(Schema.String),
	metadataId: Schema.optional(Schema.String),
	packageId: Schema.optional(Schema.String),
});
export type CoinEntry = typeof CoinEntry.Type;

// -----------------------------------------------------------------------------
// App section — dev/wallet endpoints + extras escape hatch
// -----------------------------------------------------------------------------

export const AppManifest = Schema.Struct({
	dev: Schema.optional(EndpointEntry),
	wallet: Schema.optional(EndpointEntry),
	extras: Schema.Record(Schema.String, Schema.Unknown),
});
export type AppManifest = typeof AppManifest.Type;

// -----------------------------------------------------------------------------
// Stack identity — name, network, app
// -----------------------------------------------------------------------------

export const StackIdentity = Schema.Struct({
	name: Schema.String,
	network: Schema.String,
	app: Schema.String,
});
export type StackIdentity = typeof StackIdentity.Type;

// -----------------------------------------------------------------------------
// Top-level Manifest
// -----------------------------------------------------------------------------

/** The manifest schema. The on-disk shape of `.devstack/manifest.json`
 *  written by `runtime/manifest-emit.ts` and consumed by codegen
 *  emitters via `gatherManifest()`. */
export const Manifest = Schema.Struct({
	stack: StackIdentity,
	services: ServicesManifest,
	packages: Schema.Record(Schema.String, PackageEntry),
	accounts: Schema.Record(Schema.String, AccountEntry),
	coins: Schema.Record(Schema.String, CoinEntry),
	app: AppManifest,
});

/** The fully-typed manifest. Use this as the type for any code that
 *  consumes a parsed manifest. */
export type Manifest = typeof Manifest.Type;
