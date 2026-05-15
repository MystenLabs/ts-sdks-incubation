// Deepbook(opts) — canonical Deepbook factory. Picks local-deploy or
// known-package based on `mode`. Returns a single Ref carrying the
// resolved deepbook deployment (package id, pools).
//
// Market-making is a separate factory (`DeepbookMarketMaker`) so the
// caller can compose order: it typically `needs:` the deploy ref + a
// seed-tokens action so balances are present before the first tick.
//
// This file also carries the **DeepbookCore** (read-side) /
// **DeepbookAdmin** (local-only) / **DeepbookMarketMakerTag** (local-only,
// renamed so the factory `DeepbookMarketMaker(opts)` can take the
// public-surface name) Context.Service tags. Split along the capability
// axis so future known-package factories can produce a strict subset
// (`DeepbookCore` only) without faking an admin cap.

import { Context, Effect, Schema } from 'effect';
import {
	deepbookKnownPackage,
	deepbookLocalDeploy,
	deepbookMarketMaker,
	type DeepbookKnownPackageOptions,
} from './deepbook/index.js';
import { DeepbookError } from '../engine/errors.js';

// -----------------------------------------------------------------------------
// DeepbookCore — read-side view
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
 *  - `packageId` / `registryId` are chain-state pointers. Kept lowercase
 *    for readability + backwards compat. They mirror
 *    `packageIds.DEEPBOOK_PACKAGE_ID` / `packageIds.REGISTRY_ID`.
 *  - `packageIds` is the SCREAMING_SNAKE_CASE view consumed verbatim by
 *    `@mysten/deepbook-v3`'s `DeepBookClient` constructor — see field
 *    JSDoc below.
 *  - `poolIds` is a flat name → id map. The current primitive yields a
 *    richer `Record<string, DeepbookPool>`; this contract narrows to
 *    the minimal lookup surface so known-package factories that don't
 *    own the pool specs can still produce a `DeepbookCore` value.
 *  - `findPool` is a typed lookup that fails when the pool isn't
 *    declared on this deployment. Lifts the lookup out of consumer
 *    code so the "pool not declared" error stays consistent across
 *    primitives.
 */
export interface DeepbookCoreShape {
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

export class DeepbookCore extends Context.Service<DeepbookCore, DeepbookCoreShape>()(
	'@devstack/DeepbookCore',
) {}

// -----------------------------------------------------------------------------
// DeepbookAdmin — local-only admin capabilities
// -----------------------------------------------------------------------------

/** Local-only admin capabilities. Remote `deepbookKnownPackage`
 *  factories will NOT produce a `DeepbookAdmin` layer, so any code
 *  that depends on it is type-checked away from running against a
 *  remote Deepbook deployment we don't own the admin cap for.
 *
 *  Empty contract today — Phase 6a will fill it with real admin
 *  operations (upgrade-cap rotation, package admin tx helpers). Kept
 *  as a placeholder so consumer types can already say "I need
 *  DeepbookAdmin" and pick up the fields once they arrive without
 *  another rename pass. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DeepbookAdminShape {}

export class DeepbookAdmin extends Context.Service<DeepbookAdmin, DeepbookAdminShape>()(
	'@devstack/DeepbookAdmin',
) {}

// -----------------------------------------------------------------------------
// DeepbookMarketMakerTag — local-only market-making capabilities
// -----------------------------------------------------------------------------

/** Local-only market-making capabilities. Sits next to `DeepbookAdmin`
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
export interface DeepbookMarketMakerShape {
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
	DeepbookMarketMakerShape
>()('@devstack/DeepbookMarketMaker') {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

// `DeepbookCoreShape` carries an Effect value (`findPool`) — omit a
// Schema mirror for now; structural validation isn't useful when most
// of the surface is closures. Same applies to `DeepbookMarketMakerShape`
// (carries `tickPool`) and the currently-empty `DeepbookAdminShape`.
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
	/** Which Deepbook source. `'auto'` picks `'local'` by default. */
	readonly mode?: 'auto' | 'local' | 'known';
	/** Pass-through extras for the local-deploy path. See
	 *  `DeepbookLocalDeployOptions` for the full surface. */
	readonly local?: Record<string, unknown>;
	/** Pass-through extras for the known-package path. */
	readonly known?: DeepbookKnownPackageOptions;
	/** Override tag name. Defaults to `'deepbook'`. */
	readonly name?: string;
}

const resolveMode = (opts: DeepbookOptions): 'local' | 'known' => {
	if (opts.mode === 'local' || opts.mode === 'known') return opts.mode;
	return 'local';
};

/** Deepbook factory. Returns a single Ref that resolves to the deployed
 *  package id + pool map. Pair with {@link DeepbookMarketMaker} when
 *  continuous liquidity is needed. */
export const Deepbook = (opts: DeepbookOptions = {}) => {
	const mode = resolveMode(opts);
	if (mode === 'known') {
		return Object.assign(deepbookKnownPackage(opts.known ?? {}), { __kind: 'service' as const });
	}
	const localOpts = {
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.local ?? {}),
	} as Parameters<typeof deepbookLocalDeploy>[0];
	return Object.assign(deepbookLocalDeploy(localOpts), { __kind: 'service' as const });
};

/** Market-maker factory. Spawns a fiber that posts POST_ONLY orders on
 *  each named pool. Typically `needs:` the {@link Deepbook} deploy ref
 *  + whatever seeds the maker's balance manager with inventory. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookMarketMaker = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Object.assign((deepbookMarketMaker as any)(opts), { __kind: 'action' as const });
