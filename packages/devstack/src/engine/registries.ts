// Internal registries — collected into the manifest at finalization.
// Each user-facing primitive (sui, publishMove, accounts, ...) registers
// itself into these as part of its scoped acquisition.
//
// Exposed (read-only-ish) to plugin-author code through the free-standing
// `publishEndpoint` / `requireEndpoint` (etc.) functions; users never poke
// the bare `Context.Service` shape themselves.
//
// The dependency-edge problem
// ---------------------------
// Layers are acquired in parallel. If primitive B reads from a registry
// without yielding the upstream tag that publishes into it, Layer.build
// sees no dependency edge between A and B — B can race ahead of A and
// observe a partial registry. The `require*(tag)` helpers exist purely
// to thread the upstream tag through the R channel: the call yields
// `tag` first (forcing the ordering at the type level and at runtime),
// then returns the underlying registry service.
//
// Cookbook
// --------
// Adding a new registry is three lines: declare the record interface,
// declare the `Context.Service` tag class, destructure `defineRegistry`
// for the Live layer + `publish` / `require` wrappers. See
// `engine/define-registry.ts` for the contract.

import { Context, Layer } from 'effect';
import { defineRegistry } from './define-registry.js';
export { type RegistryShape, makeRegistryLive } from './define-registry.js';

export interface PackageRecord {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrPlaceholder?: string;
	readonly captured?: Record<string, unknown>;
}

export interface EndpointRecord {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
	readonly pairUrl?: string;
}

export interface AccountRecord {
	readonly name: string;
	readonly address: string;
}

// Per-service state registries — singletons in practice (one Sui, one
// Seal, one Walrus, one Deepbook per stack), but kept array-shaped with
// a `name` field for symmetry with the rest of the registries. Last-
// write-wins per name; `gatherManifest` reads the snapshot to populate
// the corresponding `services.*` fields in the manifest.

export interface SuiStateRecord {
	readonly name: string;
	readonly chainId: string;
}

export interface SealStateRecord {
	readonly name: string;
	/** On-chain `KeyServer` object id (BLS public key + URL). Surfaced
	 *  in `services.seal.objectId` so consumers can pass it to
	 *  `SealClient`'s `serverConfigs`. */
	readonly objectId: string;
}

export interface WalrusStateRecord {
	readonly name: string;
	/** Walrus system object id — the on-chain registry the storage
	 *  protocol reads committee + epoch state from. Surfaced in
	 *  `services.walrus.systemObjectId`. */
	readonly systemObjectId: string;
}

export interface DeepbookPoolStateEntry {
	readonly poolId: string;
	readonly baseType: string;
	readonly quoteType: string;
}

export interface DeepbookStateRecord {
	readonly name: string;
	readonly packageId: string;
	readonly registryId?: string;
	readonly pools: Record<string, DeepbookPoolStateEntry>;
}

export interface PythStateRecord {
	readonly name: string;
	readonly packageId: string;
	readonly pythStateId?: string;
	readonly wormholeStateId?: string;
	/** Pyth feed-id (mainnet hex) → on-chain PriceInfoObject id. */
	readonly priceInfoObjectIds: Record<string, string>;
	/** Friendly label (e.g. `'SUI'`, `'DEEP'`) → feed-id. */
	readonly feeds: Record<string, string>;
}

export interface PostgresStateRecord {
	readonly name: string;
	readonly user: string;
	/** Connection URL with credentials, e.g.
	 *  `postgres://devstack:<pw>@<alias>:5432/<db>`. NOT persisted to
	 *  manifest — `password` is stripped at the manifest grouper. */
	readonly url: string;
	readonly endpoint: string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
	readonly databases: ReadonlyArray<string>;
}

export interface DeepbookIndexerStateRecord {
	readonly name: string;
	readonly metricsUrl: string;
	readonly databaseUrl: string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
}

// Phase 3 — DeepBook server state. Captures both the REST URL (the
// primary consumer-facing endpoint that the codegen emitter projects)
// and the Prometheus metrics URL (matches the indexer's shape). The
// server is stateless against the writable layer; everything it serves
// is read on demand from the postgres + chain RPC pair, so the record
// only carries dial info — no captured object ids.
export interface DeepbookServerStateRecord {
	readonly name: string;
	readonly restUrl: string;
	readonly metricsUrl: string;
	readonly databaseUrl: string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
}

// Phase 4 — DeepBook margin state. Captures the published margin +
// liquidation package ids, the MarginRegistry + MaintainerCap shared
// objects created by the margin Move source, and the per-asset
// MarginPool object ids the factory creates as part of its single
// batched setup tx. `registeredPools` carries the deepbook pool ids
// the factory registered against the margin registry (sandbox parity).
export interface DeepbookMarginPoolStateEntry {
	readonly label: string;
	readonly assetType: string;
	readonly marginPoolId: string;
}

export interface DeepbookMarginStateRecord {
	readonly name: string;
	readonly packageId: string;
	readonly liquidationPackageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly maintainerCapId?: string;
	readonly marginPools: ReadonlyArray<DeepbookMarginPoolStateEntry>;
	readonly registeredPools: ReadonlyArray<string>;
}

export interface CoinRecord {
	readonly name: string;
	readonly type: string;
	readonly decimals: number;
	/**
	 * SDK-aligned projection. Optional in the registry so plugin authors
	 * publishing into `CoinRegistry` from a custom primitive don't have
	 * to derive the field manually — `manifest({})` backfills it from
	 * `(type, decimals)` when missing.
	 */
	readonly sdkCoin?: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
	// Coin-auto-discovery fields. The publish-discovery pass folds its
	// findings here directly — no separate user-spec'd `coins:` loop.
	// Fields are optional because some coins (custom init that bypasses
	// `coin::create_currency`, snapshot-restored entries) won't have a
	// full payload to surface.

	/** Canonical CoinMetadata symbol (e.g. `'mUSDC'`). Populated from
	 *  `client.core.getCoinMetadata`'s payload at publish time. The
	 *  Phase-3 `Coin('SYMBOL')` factory looks this up via a symbol-keyed
	 *  index over the registry snapshot. Optional because coins minted
	 *  via a custom init that bypasses `coin::create_currency` have no
	 *  on-chain metadata. */
	readonly symbol?: string;
	/** Human-readable coin name (e.g. `'Mock USD Coin'`). Surfaces in
	 *  the dev-wallet UI's balance row alongside `symbol`. Named
	 *  `displayName` (not `name`) because the existing `CoinRecord.name`
	 *  field is the registry key (user-supplied tag like `'musdc'`); a
	 *  field collision would be a footgun for downstream `coin.name`
	 *  readers. The manifest emit + the Phase-5 generated coin record
	 *  surface this as `coin.displayName`. */
	readonly displayName?: string;
	/** Optional icon URL the CoinMetadata carries. Populates dev-wallet
	 *  UI thumbnails when present. Stripped to `undefined` when the
	 *  on-chain field is empty / null. */
	readonly iconUrl?: string;
	/** TreasuryCap object id captured from the publish receipt. Same
	 *  value Phase-0 `discoverCoinsFromPublish` surfaces; folded here so
	 *  faucet auto-registration + Phase-3 `Coin('SYMBOL')` resolve mint
	 *  capability without re-querying chain state. `undefined` for
	 *  coins where the publish didn't produce a cap (read-only coin
	 *  case: cap was transferred or burned in init). */
	readonly treasuryCapId?: string;
	/** CoinMetadata object id. The dev-wallet UI used to fetch this
	 *  via `client.core.getCoinMetadata` per coin at boot time; once
	 *  this field is populated in the manifest the UI can skip that
	 *  RPC waterfall. `undefined` for coins without on-chain
	 *  metadata. */
	readonly metadataId?: string;
	/** The publishing package's id. Stored here so the symbol-keyed
	 *  registry collision fallback (`${packageId.slice(0,6)}.${witness}`)
	 *  doesn't have to re-parse from `type`. Optional because hand-rolled
	 *  `publishCoin` callers (unit tests) don't always supply it; the
	 *  discovery path in `publishMove` always does. */
	readonly packageId?: string;
}

import type { RegistryShape } from './define-registry.js';

// -----------------------------------------------------------------------------
// Registry tag classes — one per registry. The class identity is the
// canonical narrow-type for `yield* X`, so every consumer reading the
// snapshot gets `RegistryShape<X>` (not the erased `RegistryShape<unknown>`).
// `defineRegistry(...)` below absorbs the Live + publish + require dance.
// -----------------------------------------------------------------------------

export class PackageRegistry extends Context.Service<
	PackageRegistry,
	RegistryShape<PackageRecord>
>()('@devstack/PackageRegistry') {}

export class EndpointRegistry extends Context.Service<
	EndpointRegistry,
	RegistryShape<EndpointRecord>
>()('@devstack/EndpointRegistry') {}

export class AccountRegistry extends Context.Service<
	AccountRegistry,
	RegistryShape<AccountRecord>
>()('@devstack/AccountRegistry') {}

export class CoinRegistry extends Context.Service<CoinRegistry, RegistryShape<CoinRecord>>()(
	'@devstack/CoinRegistry',
) {}

export class SuiStateRegistry extends Context.Service<
	SuiStateRegistry,
	RegistryShape<SuiStateRecord>
>()('@devstack/SuiStateRegistry') {}

export class SealStateRegistry extends Context.Service<
	SealStateRegistry,
	RegistryShape<SealStateRecord>
>()('@devstack/SealStateRegistry') {}

export class WalrusStateRegistry extends Context.Service<
	WalrusStateRegistry,
	RegistryShape<WalrusStateRecord>
>()('@devstack/WalrusStateRegistry') {}

export class DeepbookStateRegistry extends Context.Service<
	DeepbookStateRegistry,
	RegistryShape<DeepbookStateRecord>
>()('@devstack/DeepbookStateRegistry') {}

export class PythStateRegistry extends Context.Service<
	PythStateRegistry,
	RegistryShape<PythStateRecord>
>()('@devstack/PythStateRegistry') {}

export class PostgresStateRegistry extends Context.Service<
	PostgresStateRegistry,
	RegistryShape<PostgresStateRecord>
>()('@devstack/PostgresStateRegistry') {}

export class DeepbookIndexerStateRegistry extends Context.Service<
	DeepbookIndexerStateRegistry,
	RegistryShape<DeepbookIndexerStateRecord>
>()('@devstack/DeepbookIndexerStateRegistry') {}

export class DeepbookServerStateRegistry extends Context.Service<
	DeepbookServerStateRegistry,
	RegistryShape<DeepbookServerStateRecord>
>()('@devstack/DeepbookServerStateRegistry') {}

export class DeepbookMarginStateRegistry extends Context.Service<
	DeepbookMarginStateRegistry,
	RegistryShape<DeepbookMarginStateRecord>
>()('@devstack/DeepbookMarginStateRegistry') {}

// -----------------------------------------------------------------------------
// Live layers + publish + require — produced by `defineRegistry` so the
// per-registry boilerplate (Layer.effect + free-function wrappers) lives
// in one place. Tag identity stays narrow because the class declarations
// above carry it; the factory is type-erased over the record type.
// -----------------------------------------------------------------------------

export const {
	Live: PackageRegistryLive,
	publish: publishPackage,
	require: requirePackageRegistry,
} = defineRegistry<PackageRegistry, PackageRecord>(PackageRegistry);

// EndpointRegistry's Live layer also seeds the EngineHandle observer in
// `engine/engine.ts` (the `EndpointRegistryWithEngineLive` variant). The
// supervisor wires that variant in; this `Live` is the plain registry
// path used by direct tests that don't need engine hooks.
export const {
	Live: EndpointRegistryLive,
	publish: publishEndpoint,
	require: requireEndpointRegistry,
} = defineRegistry<EndpointRegistry, EndpointRecord>(EndpointRegistry);

export const {
	Live: AccountRegistryLive,
	publish: publishAccount,
	require: requireAccountRegistry,
} = defineRegistry<AccountRegistry, AccountRecord>(AccountRegistry);

export const {
	Live: CoinRegistryLive,
	publish: publishCoin,
	require: requireCoinRegistry,
} = defineRegistry<CoinRegistry, CoinRecord>(CoinRegistry);

export const { Live: SuiStateRegistryLive, publish: publishSuiState } = defineRegistry<
	SuiStateRegistry,
	SuiStateRecord
>(SuiStateRegistry);

export const { Live: SealStateRegistryLive, publish: publishSealState } = defineRegistry<
	SealStateRegistry,
	SealStateRecord
>(SealStateRegistry);

export const { Live: WalrusStateRegistryLive, publish: publishWalrusState } = defineRegistry<
	WalrusStateRegistry,
	WalrusStateRecord
>(WalrusStateRegistry);

export const { Live: DeepbookStateRegistryLive, publish: publishDeepbookState } = defineRegistry<
	DeepbookStateRegistry,
	DeepbookStateRecord
>(DeepbookStateRegistry);

export const { Live: PythStateRegistryLive, publish: publishPythState } = defineRegistry<
	PythStateRegistry,
	PythStateRecord
>(PythStateRegistry);

export const { Live: PostgresStateRegistryLive, publish: publishPostgresState } = defineRegistry<
	PostgresStateRegistry,
	PostgresStateRecord
>(PostgresStateRegistry);

export const { Live: DeepbookIndexerStateRegistryLive, publish: publishDeepbookIndexerState } =
	defineRegistry<DeepbookIndexerStateRegistry, DeepbookIndexerStateRecord>(
		DeepbookIndexerStateRegistry,
	);

export const { Live: DeepbookServerStateRegistryLive, publish: publishDeepbookServerState } =
	defineRegistry<DeepbookServerStateRegistry, DeepbookServerStateRecord>(
		DeepbookServerStateRegistry,
	);

export const { Live: DeepbookMarginStateRegistryLive, publish: publishDeepbookMarginState } =
	defineRegistry<DeepbookMarginStateRegistry, DeepbookMarginStateRecord>(
		DeepbookMarginStateRegistry,
	);

// -----------------------------------------------------------------------------
// Bundled Live layer — every registry the platform wires by default.
// Engine-aware variants (e.g. `EndpointRegistryWithEngineLive` in
// `engine.ts`) replace specific entries via `Layer.mergeAll`'s
// later-wins semantics.
// -----------------------------------------------------------------------------

export const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
	PythStateRegistryLive,
	PostgresStateRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
);
