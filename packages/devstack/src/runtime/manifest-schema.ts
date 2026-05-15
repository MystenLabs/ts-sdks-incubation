// Manifest v4 schema — single source of truth for the on-disk
// `.devstack/manifest.json` shape, the `Devstack` Effect Service shape,
// and the `fromManifest(json)` POJO accessor.
//
// v4 reorganizes v3's flat arrays (`endpoints[]`, `packages[]`,
// `accounts[]`, `coins[]`) into records keyed by name and sections by
// user intent (`services`, `packages`, `accounts`, `app`, `coins`). The
// v3 → v4 in-memory migration lives in `manifest-loader.ts`; both
// shapes are readable for one release, then v3 is deleted in Phase 6.
//
// Endpoints render as full traefik-routed hostnames (e.g.
// `http://sui.<app>.localhost:9000`) in the canonical `url` field. The
// optional `alternates` array carries loopback-style URLs for callers
// that can't resolve `*.localhost` wildcards. This is consumed by the
// TUI (shows `url` only) and the manifest (serializes both).

import { Schema } from 'effect';

// -----------------------------------------------------------------------------
// Endpoint entry — the canonical { url, alternates? } shape used everywhere
// -----------------------------------------------------------------------------

/** A reachable URL plus optional fallback forms. Replaces v3's
 *  `{name, url, kind?, pairUrl?}` flat entries. */
export const EndpointEntry = Schema.Struct({
	url: Schema.String,
	alternates: Schema.optional(Schema.Array(Schema.String)),
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

export const DeepbookManifest = Schema.Struct({
	packageId: Schema.String,
	registryId: Schema.optional(Schema.String),
	pools: Schema.Record(Schema.String, DeepbookPoolEntry),
});
export type DeepbookManifest = typeof DeepbookManifest.Type;

export const ServicesManifest = Schema.Struct({
	sui: Schema.optional(SuiManifest),
	seal: Schema.optional(SealManifest),
	walrus: Schema.optional(WalrusManifest),
	deepbook: Schema.optional(DeepbookManifest),
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
// Top-level Manifest v4
// -----------------------------------------------------------------------------

/** The v4 manifest schema. The on-disk shape of `.devstack/manifest.json`
 *  written by `runtime/manifest-emit.ts` and read by
 *  `runtime/manifest-loader.ts`. Same shape drives the `Devstack` Effect
 *  Service.
 *
 *  v3 manifests on disk are migrated to v4 in-memory by the loader; v3
 *  emission can be re-enabled behind a feature flag for one release and
 *  is removed in Phase 6. */
export const ManifestV4 = Schema.Struct({
	version: Schema.Literal(4),
	stack: StackIdentity,
	services: ServicesManifest,
	packages: Schema.Record(Schema.String, PackageEntry),
	accounts: Schema.Record(Schema.String, AccountEntry),
	coins: Schema.Record(Schema.String, CoinEntry),
	app: AppManifest,
});

/** The fully-typed v4 manifest. Use this as the type for any code that
 *  consumes a parsed manifest. */
export type Manifest = typeof ManifestV4.Type;

/** Decoded form: identical to `Manifest`. Kept distinct in case the
 *  Schema later introduces transformations (e.g. bigint coercion on
 *  `coins[*].decimals` for chains that need it). */
export type ManifestEncoded = typeof ManifestV4.Encoded;
