// Interface contracts for published Move packages.
//
// Two shapes:
//   - `Package` — minimal contract every package-producing factory
//     satisfies (`deepbookKnownPackage`, `walrusKnownPackage`, etc).
//     Carries only fields downstream consumers (bindings, action) need
//     to address a package on chain.
//   - `LocalPackage` extends `Package` with fields that are only
//     meaningful when WE published the package ourselves (source path,
//     captured object ids, MVR placeholder). Phase 7's `bindings` rebinds
//     to `LocalPackage` so the type system catches a bindings wired to a
//     known-package config.
//
// These are TEMPLATES. Stacks have multiple packages, so the actual
// per-named-package tagging (e.g. `pkg.usdc` vs `pkg.deepbook`) still
// happens in `publish-move.ts` via `makeTag(name, ...)`. This file pins
// the SHAPE every such per-named tag must satisfy.

import { Context, Schema } from 'effect';

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
 *  package" rather than a specific named one. */
export class Package extends Context.Service<Package, PackageShape>()('@devstack/Package') {}

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

export class LocalPackage extends Context.Service<LocalPackage, LocalPackageShape>()(
	'@devstack/LocalPackage',
) {}

/** Runtime-validation mirror of `PackageShape`. Use
 *  `Schema.decode(PackageShapeSchema)` to validate a `Layer.succeed(Package, ...)`
 *  you wrote yourself, or in tests where you want to assert the shape on yield. */
export const PackageShapeSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
});

/** Runtime-validation mirror of `LocalPackageShape`. Use
 *  `Schema.decode(LocalPackageShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(LocalPackage, ...)`, or in tests where you want to
 *  assert the shape on yield. */
export const LocalPackageShapeSchema = Schema.Struct({
	name: Schema.String,
	packageId: Schema.String,
	upgradeCapId: Schema.UndefinedOr(Schema.String),
	sourcePath: Schema.String,
	mvrPlaceholder: Schema.String,
	captured: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Unknown)),
});
