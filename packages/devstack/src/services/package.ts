// Package(name, path, opts) — publishing a local Move package.
//
//   Package('hello', './move/hello', { signer: alice })
//
// Coin auto-discovery (`notes/coin-auto-discovery.md`) runs implicitly
// on every publish: every `coin::create_currency<W>` call in the
// package's `init` surfaces in `pkg.coins[<symbol>]` and registers in
// the global `CoinRegistry` for the `Coin('SYMBOL')` factory. The
// `UpgradeCap` is auto-captured into `pkg.upgradeCapId`.
//
// **No `capture:` field, no `coins:` field.** Plugin authors needing
// to extract additional object ids from the publish receipt reach for
// `PackageWithCapture` on `/advanced` — that factory accepts a
// `capture(changes)` lambda for the unusual cases (DAO patterns,
// custom init that creates non-standard shared objects).
//
// This file also carries the **Package / LocalPackage** Context.Service
// tags (renamed `PackageTag` / `LocalPackageTag` so the factory name
// can occupy `Package`) and the **CoinTag** Context.Service tag + the
// `toSdkCoin` projection used by `publishMove` / the manifest emitter.
// The CoinTag tag lives here because every coin originates from a
// published Package's coin registry.

import { Context, Schema } from 'effect';
import { publishMove, type PublishMoveOptions } from './package/internal.js';
import { pickCreatedByType } from '../engine/sui-helpers.js';
import type { Account, SuiObjectChange } from '../engine/shared.js';
import type { LayeredTag } from '../advanced/tag.js';

// -----------------------------------------------------------------------------
// Package contracts
// -----------------------------------------------------------------------------

/** Minimal package contract. Both `publishMove` and any future
 *  `knownPackage` factory satisfy this — known packages on a remote
 *  network won't have an upgrade cap visible to the dev (hence
 *  `upgradeCapId: string | undefined`). */
export interface Package {
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
 *  (`'@devstack/PackageTag'`) is unchanged. */
export class PackageTag extends Context.Service<PackageTag, Package>()('@devstack/PackageTag') {}

/** Refined shape for packages WE publish from local sources. Adds the
 *  fields that are only meaningful in that mode:
 *    - `sourcePath` — root of the Move package on disk (used by
 *      `bindings` for `sui move summary`). Echoes the `path` argument
 *      the caller passed positionally to `Package(name, path, opts)`,
 *      resolved to the form downstream emitters consume.
 *    - `mvrPlaceholder` — name `bindings` emits in generated code
 *      instead of the chain-specific `packageId`.
 *    - `captured` — opaque per-package object ids the caller's
 *      `capture` lambda extracted from `objectChanges` at publish time
 *      (e.g. deepbook's `registryId`/`adminCapId`). Open record so the
 *      shape stays composable; concrete types tighten at call sites.
 */
export interface LocalPackage extends Package {
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
	readonly captured: Record<string, unknown> | undefined;
}

/** Renamed `LocalPackageTag` for symmetry with `PackageTag`. Context
 *  key (`'@devstack/LocalPackageTag'`) is unchanged. */
export class LocalPackageTag extends Context.Service<LocalPackageTag, LocalPackage>()(
	'@devstack/LocalPackageTag',
) {}

/** Runtime-validation mirror of `Package`. Use
 *  `Schema.decode(PackageSchema)` to validate a `Layer.succeed(PackageTag, ...)`
 *  you wrote yourself, or in tests where you want to assert the shape on yield. */
export const PackageSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
});

/** Runtime-validation mirror of `LocalPackage`. Use
 *  `Schema.decode(LocalPackageSchema)` to validate a hand-rolled
 *  `Layer.succeed(LocalPackageTag, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const LocalPackageSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
	sourcePath: Schema.String,
	mvrPlaceholder: Schema.String,
	captured: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Unknown)),
});

// -----------------------------------------------------------------------------
// CoinTag contract
// -----------------------------------------------------------------------------

/** Minimal coin contract. `fullCoinType` is the on-chain
 *  `<package>::<module>::<TYPE>` Move type string consumers (deepbook,
 *  tx builders) splice into transactions.
 *
 *  `sdkCoin` is the SDK-aligned projection consumed verbatim by
 *  `@mysten/deepbook-v3` (and any other SDK that accepts a `CoinTag` value
 *  with `{ address, type, scalar }`). Derived from our fields:
 *    - `address` = the package portion of `fullCoinType` (text before `::`)
 *    - `type`    = `fullCoinType`
 *    - `scalar`  = `10 ** decimals`
 *
 *  Pyth fields (`feed`, `currencyId`, `priceInfoObjectId`) on the SDK's
 *  `CoinTag` shape are intentionally out of scope here — consumers that
 *  need them override per-coin in their own config layered on top.
 */
export interface Coin {
	readonly name: string;
	readonly fullCoinType: string;
	readonly decimals: number;
	/**
	 * SDK-ready coin entry. Pass directly to deepbook / dapp-kit utilities
	 * that consume `@mysten/deepbook-v3`'s `CoinTag` shape.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

export class CoinTag extends Context.Service<CoinTag, Coin>()('@devstack/CoinTag') {}

// `toSdkCoin` lives in `runtime/sdk-coin.ts` (the manifest's SdkCoinEntry
// is the canonical destination). Re-exported here so service code that
// builds Coin entries imports from the same module as `Coin` / `CoinTag`.
export { toSdkCoin } from '../runtime/sdk-coin.js';

/** Runtime-validation mirror of `Coin`. Use
 *  `Schema.decode(CoinSchema)` to validate a hand-rolled
 *  `Layer.succeed(CoinTag, ...)`, or in tests where you want to assert the
 *  shape on yield. */
export const CoinSchema = Schema.Struct({
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

export interface PackageOptions {
	/** Account that signs the publish transaction and ends up holding
	 *  the resulting `UpgradeCap`. */
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Override the MVR placeholder. Defaults to `@local/<slug-of-name>`. */
	readonly mvr?: string;
	/** Opt out of codegen for this package, or supply a per-package
	 *  emitter list that overrides the stack-level `Codegen({ emitters })`.
	 *  `false` excludes this package from every `Codegen(...)` ref in the
	 *  stack. Default `true` — the package participates in codegen using
	 *  whatever emitters the global `Codegen` ref declares. */
	readonly codegen?: boolean | { readonly emitters?: ReadonlyArray<unknown> };
}

/** Publishing factory. Returns a LayeredTag carrying the published-package
 *  shape (id, auto-discovered coins, upgradeCapId). Pass the ref into
 *  `Action({ needs: [pkg] })` or `Codegen({...})` to make the publish
 *  a prerequisite.
 *
 *  Argument-vs-output naming: the positional `path` you pass here is the
 *  filesystem path to the Move package root (directory containing
 *  `Move.toml`). It surfaces on the resolved `LocalPackage` value as
 *  `sourcePath` — the resolved (and conventionally absolute) form the
 *  `bindings` emitter and the `sui move summary` invocation read back.
 *  The asymmetry mirrors the input/output split elsewhere in devstack
 *  (`Sui*Options.rpcUrl` → `Sui.rpc.host`): inputs accept the raw
 *  string the user types, outputs name the role the value plays.
 *
 *  Coin auto-discovery: every `coin::create_currency<W>(...)` call in
 *  the package's `init` surfaces as `pkg.coins[<symbol>]` carrying
 *  `{ name, fullCoinType, decimals, sdkCoin, treasuryCapId?, metadataId?,
 *  symbol?, displayName?, iconUrl? }`. Address coins by symbol via
 *  `Coin('SYMBOL')` or by package + witness via `Coin.fromPackage(pkg,
 *  'WITNESS')`. The `UpgradeCap` is auto-captured into
 *  `pkg.upgradeCapId`.
 *
 *  Need a non-coin object id captured from `objectChanges`? Reach for
 *  `PackageWithCapture` on `/advanced` — that factory accepts a
 *  `capture(changes)` lambda for unusual cases (DAO patterns, custom
 *  init that creates non-standard shared objects). */
export const Package = <const N extends string>(
	name: N,
	path: string,
	opts: PackageOptions,
) => {
	const publishOpts: PublishMoveOptions<N, undefined> = {
		name,
		path,
		signer: opts.signer,
		...(opts.mvr !== undefined ? { mvrPlaceholder: opts.mvr } : {}),
	};
	// `codegen: false` is stamped onto the LayeredTag object so any `Codegen(...)`
	// in the stack that reads its `packages` list can filter this entry out.
	// `true` (the default) is omitted — Codegen treats absence as opt-in.
	const codegenExclude = opts.codegen === false;
	return Object.assign(publishMove(publishOpts), {
		__kind: 'package' as const,
		__pluginName: 'move',
		...(codegenExclude ? { __codegenExclude: true as const } : {}),
	});
};

// -----------------------------------------------------------------------------
// PackageWithCapture — /advanced escape hatch
// -----------------------------------------------------------------------------

/** Two accepted shapes for `capture`. */
export type CaptureSpec<TCaptured> =
	/** Declarative form: map of result-key → type-substring. Each entry
	 *  picks the first created object whose type contains the substring.
	 *  Result is a `Record<key, string>` of object ids. */
	| Record<string, string>
	/** Callback form: receives the full `objectChanges` array, returns
	 *  whatever shape you like. Used when the declarative form isn't
	 *  expressive enough. */
	| ((changes: ReadonlyArray<SuiObjectChange>) => TCaptured);

/** Compile a `capture` spec down to the callback form `publishMove`
 *  expects. Record form looks up each value via `pickCreatedByType`
 *  (`includes` filter); callback form passes through. */
const compileCapture = <TCaptured>(
	spec: CaptureSpec<TCaptured>,
): (changes: ReadonlyArray<SuiObjectChange>) => TCaptured => {
	if (typeof spec === 'function') return spec;
	return (changes) => {
		const out: Record<string, string | undefined> = {};
		for (const [k, typeSubstring] of Object.entries(spec)) {
			out[k] = pickCreatedByType(changes, { includes: typeSubstring });
		}
		return out as unknown as TCaptured;
	};
};

export interface PackageWithCaptureOptions<TCaptured> extends PackageOptions {
	/** Object-id capture. See {@link CaptureSpec}.
	 *
	 *  The declarative form is the common case:
	 *  ```ts
	 *  PackageWithCapture('dao', './move/dao', {
	 *    signer: publisher,
	 *    capture: { adminCapId: '::dao::AdminCap', registryId: '::dao::Registry' },
	 *  });
	 *  ```
	 *
	 *  Use the callback form when the declarative match isn't enough
	 *  (e.g. when an id needs to be derived from multiple object
	 *  changes). */
	readonly capture: CaptureSpec<TCaptured>;
}

/** `/advanced` publishing factory for plugin authors who need a typed
 *  `pkg.captured.<key>` projection beyond coin auto-discovery. Coin
 *  auto-discovery still runs (every `coin::create_currency<W>(...)`
 *  surfaces in `pkg.coins[<symbol>]`); `capture` runs alongside and
 *  projects whatever the user's lambda returns into `pkg.captured`.
 *
 *  This factory is on `/advanced` rather than the main barrel because
 *  the common case is now coin auto-discovery — the `Package(...)`
 *  factory above. Reach for `PackageWithCapture` when:
 *    - the package's `init` creates non-coin shared objects you need
 *      addressable from app code (admin caps, registries, DAO objects),
 *    - or a DAO pattern transfers a TreasuryCap to a shared/owned
 *      object at publish time and you need to track its id. */
export const PackageWithCapture = <const N extends string, TCaptured = undefined>(
	name: N,
	path: string,
	opts: PackageWithCaptureOptions<TCaptured>,
) => {
	const publishOpts: PublishMoveOptions<N, TCaptured> = {
		name,
		path,
		signer: opts.signer,
		...(opts.mvr !== undefined ? { mvrPlaceholder: opts.mvr } : {}),
		capture: compileCapture<TCaptured>(opts.capture),
	};
	const codegenExclude = opts.codegen === false;
	return Object.assign(publishMove(publishOpts), {
		__kind: 'package' as const,
		__pluginName: 'move',
		...(codegenExclude ? { __codegenExclude: true as const } : {}),
	});
};
