// Package(name, path, opts) — publishing a local Move package. Replaces
// the v3 `publishMove({name, path, signer, mvrPlaceholder, capture, coins})`
// factory. Two new conveniences on top of v3:
//
//   - Positional `(name, path)` instead of `{name, path}` — matches
//     how users think about a package ("publish this dir as 'hello'").
//   - `capture` accepts a typed-keys-by-type-substring record in
//     addition to the v3 callback form: `{ treasuryCap: '::coin::TreasuryCap<' }`
//     resolves at acquire time to `treasuryCap: '0x...'`. The callback
//     form is preserved for users who need full programmatic control.
//
// This file also carries the **Package / LocalPackage** Context.Service
// tags (renamed `PackageTag` / `LocalPackageTag` so the factory name
// can occupy `Package`) and the **Coin** Context.Service tag + the
// `toSdkCoin` projection used by `register-coin` / `publish-move` /
// the manifest emitter. The Coin tag lives here because every coin
// originates from a published Package's coin registry.

import { Context, Schema } from 'effect';
import { publishMove, type CoinSpec, type PublishMoveOptions } from '../primitives/publish-move.js';
import { pickCreatedByTypeIncludes } from '../primitives/sui-helpers.js';
import type { Account, SuiObjectChange } from '../primitives/shared.js';
import type { PluginTag } from '../advanced/tag.js';
import { withSection } from './ref.js';

// -----------------------------------------------------------------------------
// Package contracts
// -----------------------------------------------------------------------------

/** Minimal package contract. Both `publishMove` and any future
 *  `knownPackage` factory satisfy this — known packages on a remote
 *  network won't have an upgrade cap visible to the dev (hence
 *  `upgradeCapId: string | undefined`). */
export interface PackageShape {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId: string | undefined;
}

/** Singleton-style tag template. Per-named-package tags constructed in
 *  `publish-move.ts` produce values that satisfy this shape; this tag
 *  exists for downstream consumers that want to write "I need *some*
 *  package" rather than a specific named one.
 *
 *  Renamed `PackageTag` (not `Package`) so the factory `Package(...)`
 *  in this file owns the public-surface name. The Context key
 *  (`'@devstack/Package'`) is unchanged. */
export class PackageTag extends Context.Service<PackageTag, PackageShape>()(
	'@devstack/Package',
) {}

/** Refined shape for packages WE publish from local sources. Adds the
 *  fields that are only meaningful in that mode:
 *    - `sourcePath` — root of the Move package on disk (used by
 *      `bindings` for `sui move summary`).
 *    - `mvrPlaceholder` — name `bindings` emits in generated code
 *      instead of the chain-specific `packageId`.
 *    - `captured` — opaque per-package object ids the caller's
 *      `capture` lambda extracted from `objectChanges` at publish time
 *      (e.g. deepbook's `registryId`/`adminCapId`). Open record so the
 *      shape stays composable; concrete types tighten at call sites.
 */
export interface LocalPackageShape extends PackageShape {
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
	readonly captured: Record<string, unknown> | undefined;
}

/** Renamed `LocalPackageTag` for symmetry with `PackageTag`. Context
 *  key (`'@devstack/LocalPackage'`) is unchanged. */
export class LocalPackageTag extends Context.Service<LocalPackageTag, LocalPackageShape>()(
	'@devstack/LocalPackage',
) {}

/** Runtime-validation mirror of `PackageShape`. Use
 *  `Schema.decode(PackageShapeSchema)` to validate a `Layer.succeed(PackageTag, ...)`
 *  you wrote yourself, or in tests where you want to assert the shape on yield. */
export const PackageShapeSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
});

/** Runtime-validation mirror of `LocalPackageShape`. Use
 *  `Schema.decode(LocalPackageShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(LocalPackageTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const LocalPackageShapeSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
	sourcePath: Schema.String,
	mvrPlaceholder: Schema.String,
	captured: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Unknown)),
});

// -----------------------------------------------------------------------------
// Coin contract
// -----------------------------------------------------------------------------

/** Minimal coin contract. `fullCoinType` is the on-chain
 *  `<package>::<module>::<TYPE>` Move type string consumers (deepbook,
 *  tx builders) splice into transactions.
 *
 *  `sdkCoin` is the SDK-aligned projection consumed verbatim by
 *  `@mysten/deepbook-v3` (and any other SDK that accepts a `Coin` value
 *  with `{ address, type, scalar }`). Derived from our fields:
 *    - `address` = the package portion of `fullCoinType` (text before `::`)
 *    - `type`    = `fullCoinType`
 *    - `scalar`  = `10 ** decimals`
 *
 *  Pyth fields (`feed`, `currencyId`, `priceInfoObjectId`) on the SDK's
 *  `Coin` shape are intentionally out of scope here — consumers that
 *  need them override per-coin in their own config layered on top.
 */
export interface CoinShape {
	readonly name: string;
	readonly fullCoinType: string;
	readonly decimals: number;
	/**
	 * SDK-ready coin entry. Pass directly to deepbook / dapp-kit utilities
	 * that consume `@mysten/deepbook-v3`'s `Coin` shape.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

export class Coin extends Context.Service<Coin, CoinShape>()('@devstack/Coin') {}

/**
 * Build the `sdkCoin` projection from our `(fullCoinType, decimals)`
 * pair. Exported because `registerCoin`, `publishMove({coins})`, and
 * the manifest emitter all need the same derivation — sharing a helper
 * keeps the projection consistent.
 */
export const toSdkCoin = (opts: {
	readonly fullCoinType: string;
	readonly decimals: number;
}): CoinShape['sdkCoin'] => {
	const sep = opts.fullCoinType.indexOf('::');
	const address = sep === -1 ? opts.fullCoinType : opts.fullCoinType.slice(0, sep);
	return {
		address,
		type: opts.fullCoinType,
		scalar: 10 ** opts.decimals,
	};
};

/** Runtime-validation mirror of `CoinShape`. Use
 *  `Schema.decode(CoinShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(Coin, ...)`, or in tests where you want to assert the
 *  shape on yield. */
export const CoinShapeSchema = Schema.Struct({
	name: Schema.String,
	fullCoinType: Schema.String,
	decimals: Schema.Number,
	sdkCoin: Schema.Struct({
		address: Schema.String,
		type: Schema.String,
		scalar: Schema.Number,
	}),
});

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** Two accepted shapes for `capture`. */
export type CaptureSpec<TCaptured> =
	/** Declarative form: map of result-key → type-substring. Each entry
	 *  picks the first created object whose type contains the substring.
	 *  Result is a `Record<key, string>` of object ids. */
	| Record<string, string>
	/** Callback form (v3-compatible): receives the full
	 *  `objectChanges` array, returns whatever shape you like. Used when
	 *  the declarative form isn't expressive enough. */
	| ((changes: ReadonlyArray<SuiObjectChange>) => TCaptured);

export interface PackageOptions<
	TCaptured,
	TCoins extends ReadonlyArray<CoinSpec>,
> {
	/** Account that signs the publish transaction and ends up holding
	 *  the resulting `UpgradeCap`. */
	readonly signer: PluginTag<any, Account, any, any>;
	/** Override the MVR placeholder. Defaults to `@local/<slug-of-name>`. */
	readonly mvr?: string;
	/** Object-id capture. See {@link CaptureSpec}. */
	readonly capture?: CaptureSpec<TCaptured>;
	/** Coin specs to register against the published package. */
	readonly coins?: TCoins;
}

/** Compile a `capture` spec down to the v3 callback form `publishMove`
 *  expects. Record form looks up each value via
 *  `pickCreatedByTypeIncludes`; callback form passes through. */
const compileCapture = <TCaptured>(
	spec: CaptureSpec<TCaptured> | undefined,
): ((changes: ReadonlyArray<SuiObjectChange>) => TCaptured) | undefined => {
	if (spec === undefined) return undefined;
	if (typeof spec === 'function') return spec;
	return (changes) => {
		const out: Record<string, string | undefined> = {};
		for (const [k, typeSubstring] of Object.entries(spec)) {
			out[k] = pickCreatedByTypeIncludes(changes, typeSubstring);
		}
		return out as unknown as TCaptured;
	};
};

/** Publishing factory. Returns a Ref carrying the published-package
 *  shape (id, captured, coins). Pass the ref into `Action({ needs: [pkg] })`
 *  or `Bindings({...})` to make the publish a prerequisite. */
export const Package = <
	const N extends string,
	TCaptured = undefined,
	const TCoins extends ReadonlyArray<CoinSpec> = [],
>(
	name: N,
	path: string,
	opts: PackageOptions<TCaptured, TCoins>,
) => {
	const publishOpts: PublishMoveOptions<N, TCaptured, TCoins> = {
		name,
		path,
		signer: opts.signer,
		...(opts.mvr !== undefined ? { mvrPlaceholder: opts.mvr } : {}),
		...(opts.capture !== undefined ? { capture: compileCapture<TCaptured>(opts.capture)! } : {}),
		...(opts.coins !== undefined ? { coins: opts.coins } : {}),
	};
	return withSection(publishMove(publishOpts), 'package');
};
