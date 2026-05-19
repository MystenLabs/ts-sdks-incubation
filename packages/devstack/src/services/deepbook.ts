// Deepbook(opts) — canonical Deepbook factory. Picks local-deploy or
// known-package based on `mode`. Returns a single LayeredTag carrying the
// resolved deepbook deployment (package id, pools).
//
// Market-making is a separate factory (`DeepbookMarketMaker`) so the
// caller can compose order: it typically `needs:` the deploy ref + a
// seed-tokens action so balances are present before the first tick.
//
// This file also carries the **DeepbookCoreTag** (read-side) /
// **DeepbookAdminTag** (local-only) / **DeepbookMarketMakerTag** (local-only,
// renamed so the factory `DeepbookMarketMaker(opts)` can take the
// public-surface name) Context.Service tags. Split along the capability
// axis so future known-package factories can produce a strict subset
// (`DeepbookCoreTag` only) without faking an admin cap.
//
// Snapshot participation (per AGENTS.md § "Snapshot participation") is
// answered per dispatch branch:
//   - **Local-deploy branch:** see `./deepbook/local-deploy.ts` for the
//     authoritative section — the publish output (`packageId` +
//     `adminCapId`) lives in the state-store, pool registry IDs are
//     cached under `StateStoreKeys.deepbookPools(...)`, and the indexer /
//     server sidecars persist their schemas + rows in the colocated
//     `Postgres()` writable layer (see `services/postgres.ts`).
//   - **Known-package branch:** nothing local to persist — the resolved
//     package is on-chain at a public network. State on restore is just
//     "whatever the upstream chain is at right now."

import { Context, Effect, Schema } from 'effect';
import {
	deepbookKnownPackage,
	deepbookLocalDeploy,
	deepbookMarketMaker,
	deepbookMargin as deepbookMarginImpl,
	deepbookMarginSeed as deepbookMarginSeedImpl,
	DeepbookMintDEEP as deepbookMintDEEP,
	DeepbookMintUSDC as deepbookMintUSDC,
	vendorDeepbook as deepbookVendor,
	DeepbookIndexer as deepbookIndexer,
	DeepbookServer as deepbookServer,
	type DeepbookKnownPackageOptions,
} from './deepbook/index.js';

export {
	DeepbookIndexerTag,
	DeepbookServerTag,
	DeepbookMarginTag,
	USDC_MARGIN_DEFAULTS,
	SUI_MARGIN_DEFAULTS,
	DEFAULT_POOL_RISK_CONFIG,
} from './deepbook/index.js';
export type {
	DeepbookIndexerOptions,
	DeepbookIndexerShape,
	DeepbookServerOptions,
	DeepbookServerShape,
	DeepbookMarginOptions,
	DeepbookMarginShape,
	DeepbookMarginAssetConfig,
	DeepbookMarginPoolRegistration,
	DeepbookMarginPoolRiskConfig,
	DeepbookMarginPool,
	DeepbookMarginSeedOptions,
	DeepbookMarginSeedAmount,
	DeepbookMarginSeedResult,
} from './deepbook/index.js';
import { DeepbookError } from '../engine/errors.js';
import { resolveNetwork } from '../engine/network.js';
import { resolveDeploymentNetwork } from '../engine/known-deployments.js';
import { makeService } from '../advanced/make-service.js';

// -----------------------------------------------------------------------------
// DeepbookCoreTag — read-side view
// -----------------------------------------------------------------------------

/** Resolved pool descriptor returned by `findPool`. Mirrors the fields
 *  consumers (market makers, tx builders) need to splice a pool into a
 *  `place_limit_order` move call. */
export interface DeepbookPoolRef {
	readonly poolId: string;
	readonly baseType: string;
	readonly quoteType: string;
}

/** Fields every Deepbook-producing factory must surface.
 *
 *  - `packageId` / `registryId` are chain-state pointers, kept lowercase
 *    for readability. They mirror
 *    `packageIds.DEEPBOOK_PACKAGE_ID` / `packageIds.REGISTRY_ID`.
 *  - `packageIds` is the SCREAMING_SNAKE_CASE view consumed verbatim by
 *    `@mysten/deepbook-v3`'s `DeepBookClient` constructor — see field
 *    JSDoc below.
 *  - `poolIds` is a flat name → id map. The current primitive yields a
 *    richer `Record<string, DeepbookPool>`; this contract narrows to
 *    the minimal lookup surface so known-package factories that don't
 *    own the pool specs can still produce a `DeepbookCoreTag` value.
 *  - `findPool` is a typed lookup that fails when the pool isn't
 *    declared on this deployment. Lifts the lookup out of consumer
 *    code so the "pool not declared" error stays consistent across
 *    primitives.
 */
export interface DeepbookCore {
	readonly packageId: string;
	readonly registryId: string;
	/**
	 * SDK-ready `DeepbookPackageIds` view. Pass directly to:
	 * ```ts
	 * new DeepBookClient({ client, address, packageIds: deepbookCore.packageIds });
	 * ```
	 * Field names match `@mysten/deepbook-v3`'s SCREAMING_SNAKE_CASE
	 * convention; optional fields (`MARGIN_*`, `LIQUIDATION_*`) are typed
	 * `string | undefined` so the local-deploy factory (which doesn't
	 * deploy margin contracts) can produce a valid shape.
	 */
	readonly packageIds: {
		readonly DEEPBOOK_PACKAGE_ID: string;
		readonly REGISTRY_ID: string;
		readonly DEEP_TREASURY_ID: string;
		readonly MARGIN_PACKAGE_ID: string | undefined;
		readonly MARGIN_REGISTRY_ID: string | undefined;
		readonly LIQUIDATION_PACKAGE_ID: string | undefined;
	};
	readonly poolIds: ReadonlyMap<string, string>;
	readonly findPool: (opts: {
		readonly base: string;
		readonly quote: string;
	}) => Effect.Effect<DeepbookPoolRef, DeepbookError>;
}

export class DeepbookCoreTag extends Context.Service<DeepbookCoreTag, DeepbookCore>()(
	'@devstack/DeepbookCoreTag',
) {}

// -----------------------------------------------------------------------------
// DeepbookAdminTag — local-only admin capabilities
// -----------------------------------------------------------------------------

/** Local-only admin capabilities. Remote `deepbookKnownPackage`
 *  factories will NOT produce a `DeepbookAdminTag` layer, so any code
 *  that depends on it is type-checked away from running against a
 *  remote Deepbook deployment we don't own the admin cap for.
 *
 *  Empty contract today — kept as a placeholder so consumer types can
 *  already declare "I need DeepbookAdminTag" and pick up real admin
 *  operations (upgrade-cap rotation, package admin tx helpers) once
 *  they're added, without another rename pass. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DeepbookAdmin {}

export class DeepbookAdminTag extends Context.Service<DeepbookAdminTag, DeepbookAdmin>()(
	'@devstack/DeepbookAdminTag',
) {}

// -----------------------------------------------------------------------------
// DeepbookMarketMakerTag — local-only market-making capabilities
// -----------------------------------------------------------------------------

/** Local-only market-making capabilities. Sits next to `DeepbookAdminTag`
 *  rather than under it because a consumer that just wants to nudge a
 *  book shouldn't have to depend on the admin surface (upgrade-cap
 *  rotation et al). Known-package factories may still produce this if
 *  the caller supplies their own balance manager.
 *
 *  - `balanceManagerId` is the BalanceManager object id orders are
 *    posted from. The local-deploy primitive mints one lazily; remote
 *    factories accept it as configuration.
 *  - `tickPool` posts a single round of POST_ONLY orders on the named
 *    pool. Surface for tooling that wants to nudge the book without
 *    instantiating a full market-maker fiber. */
export interface DeepbookMarketMaker {
	readonly balanceManagerId: string;
	readonly tickPool: (
		poolName: string,
		params: { readonly baseQty: bigint; readonly quotePrice: bigint },
	) => Effect.Effect<void, DeepbookError>;
}

/** Renamed `DeepbookMarketMakerTag` (not `DeepbookMarketMaker`) so the
 *  factory `DeepbookMarketMaker(opts)` in this file can take the
 *  public-surface name. Context key (`'@devstack/DeepbookMarketMaker'`)
 *  is unchanged. */
export class DeepbookMarketMakerTag extends Context.Service<
	DeepbookMarketMakerTag,
	DeepbookMarketMaker
>()('@devstack/DeepbookMarketMaker') {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

// `DeepbookCore` carries an Effect value (`findPool`) — omit a
// Schema mirror for now; structural validation isn't useful when most
// of the surface is closures. Same applies to `DeepbookMarketMaker`
// (carries `tickPool`) and the currently-empty `DeepbookAdmin`.
//
// The pool ref *is* a plain record, so it gets a Schema for callers
// that want to validate `findPool` results round-tripped through JSON.
/** Runtime-validation mirror of `DeepbookPoolRef`. Use
 *  `Schema.decode(DeepbookPoolRefSchema)` to validate values
 *  round-tripped through JSON (e.g. manifest reads in tests). */
export const DeepbookPoolRefSchema = Schema.Struct({
	poolId: Schema.String,
	baseType: Schema.String,
	quoteType: Schema.String,
});

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export interface DeepbookOptions {
	/** Pass-through extras for the local-deploy path (signer, move
	 *  package path, pools). See `DeepbookLocalDeployOptions` for the
	 *  full surface. Ignored on testnet/mainnet — the canonical
	 *  Deepbook deployment is already on chain there. */
	readonly local?: Record<string, unknown>;
	/** Override tag name. Defaults to `'deepbook'`. */
	readonly name?: string;
}

// Plugin authors who need to pin a private Deepbook deployment can call
// `deepbookKnownPackage({...})` directly from `/advanced` — the
// canonical-only `Deepbook()` factory intentionally exposes no
// `override:` surface (Wave 3 / §10.3): the canonical registry already
// carries every field for `testnet` / `mainnet`, and zero examples or
// tests ever set an override.

/** Deepbook factory. Picks local-deploy on localnet and the canonical
 *  remote deployment on testnet/mainnet — single source of truth is
 *  `DEVSTACK_NETWORK` (set by the CLI `--network` flag or via
 *  `devstack({ network })`). Returns a LayeredTag that resolves to the
 *  deployed package id + pool map. Pair with {@link DeepbookMarketMaker}
 *  when continuous liquidity is needed.
 *
 *  Fork mode (Phase 3, D5): when the resolved network is a `*-fork`
 *  variant, routes to `deepbookKnownPackage` against the WRAPPED
 *  upstream (e.g. `'mainnet-fork'` → `deepbookKnownPackage({network:
 *  'mainnet'})`). The fork serves the upstream's real deepbook package
 *  state so a local-deploy variant would be both unnecessary and
 *  incompatible (deepbook-v3 is not vendored as Move source on the
 *  fork side). */
export const Deepbook = (opts: DeepbookOptions = {}) => {
	const network = resolveNetwork();
	if (network !== 'localnet') {
		// `network` is one of `testnet | mainnet | *-fork`. Fork variants
		// resolve to their upstream's `KnownNetwork` key via
		// `resolveDeploymentNetwork`; live nets pass through. Plugin
		// authors needing to pin a private deployment reach for
		// `deepbookKnownPackage({...})` on `/advanced` directly.
		const knownNetwork = resolveDeploymentNetwork(network);
		const knownOpts: DeepbookKnownPackageOptions =
			knownNetwork !== undefined ? { network: knownNetwork } : {};
		return makeService('deepbook', 'service', deepbookKnownPackage(knownOpts));
	}
	const localOpts = {
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...opts.local,
	} as Parameters<typeof deepbookLocalDeploy>[0];
	return makeService('deepbook', 'service', deepbookLocalDeploy(localOpts));
};

/** Market-maker factory. Spawns a fiber that posts POST_ONLY orders on
 *  each named pool. Typically `needs:` the {@link Deepbook} deploy ref
 *  + whatever seeds the maker's balance manager with inventory. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookMarketMaker = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookMarketMaker as any)(opts));

/** Mint DEEP from the locally-deployed deepbook package's `TreasuryCap`
 *  to a recipient. Reads `deepTreasuryId` from the deepbook tag's
 *  captured fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookMintDEEP = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookMintDEEP as any)(opts));

/** Mint USDC from a caller-supplied `TreasuryCap`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookMintUSDC = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookMintUSDC as any)(opts));

/** Vendor the deepbook + deepbook-sandbox Move sources into a
 *  `.devstack/vendor/deepbook/<ref>/` tree. Returns a Ref carrying the
 *  six per-package source paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const VendorDeepbook = (opts?: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookVendor as any)(opts));

/** DeepBook indexer container. Reads Sui checkpoints + writes events
 *  to Postgres. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookIndexer = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'service', (deepbookIndexer as any)(opts));

/** DeepBook server container. Long-lived; serves the DeepBook REST API
 *  on `:9008` reading from the Postgres written to by `DeepbookIndexer`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookServer = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'service', (deepbookServer as any)(opts));

/** Publish the `deepbook_margin` + `margin_liquidation` Move packages,
 *  create one MarginPool per configured asset, and register each
 *  requested deepbook pool against the margin registry. Pyth is
 *  typecheck-required (D5). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepbookMarginAction = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookMarginImpl as any)(opts));

/** Mint a SupplierCap + supply per-asset seed liquidity to each
 *  margin pool. Mirrors sandbox parity. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepbookMarginSeedAction = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	makeService('deepbook', 'action', (deepbookMarginSeedImpl as any)(opts));

/** DeepBook margin primitive — composite factory + `.seed` action.
 *
 *  ```ts
 *  const margin = DeepbookMargin({ pyth, deepbook, signer, assets, pools, ... });
 *  // ...later, after Coin tags have published amounts to the signer:
 *  DeepbookMargin.seed({ signer, margin, amounts: [...] });
 *  ```
 *
 *  The `.seed` namespace mirrors the existing `Object.assign`-pattern
 *  used elsewhere in the package surface (see the `DeepbookMintDEEP` /
 *  `DeepbookMintUSDC` sugar above) — keeps the call sites readable
 *  without ballooning the top-level facade with two near-identical
 *  symbols. */
export const DeepbookMargin = Object.assign(deepbookMarginAction, {
	seed: deepbookMarginSeedAction,
});
