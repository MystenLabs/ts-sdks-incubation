// Interface contracts for Deepbook.
//
// Phase 6a will introduce factories that produce only the read-side
// view of a Deepbook deployment:
//   - `deepbookLocalDeploy({signer, movePackagePath, pools})` — we
//     publish and own the admin cap.
//   - `deepbookKnownPackage({packageId, registryId, pools})` — point at
//     an existing on-chain deployment with no admin access.
// Both produce `Layer<DeepbookCore>`; only the local deploy produces a
// `Layer<DeepbookAdmin>` on top.
//
// The current `primitives/deepbook.ts` collapses both views into one
// composite shape; the split below lets remote-package factories
// produce a strict subset without faking an `adminCapId`.

import { Context, Effect, Schema } from 'effect';
import { DeepbookError } from '../primitives/errors.js';

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

/** Local-only admin capabilities. Phase 6a's `deepbookKnownPackage`
 *  factory will NOT produce a `DeepbookAdmin` layer, so any code that
 *  depends on it is type-checked away from running against a remote
 *  Deepbook deployment we don't own the admin cap for.
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
// DeepbookMarketMaker — local-only market-making capabilities
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

export class DeepbookMarketMaker extends Context.Service<
	DeepbookMarketMaker,
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
