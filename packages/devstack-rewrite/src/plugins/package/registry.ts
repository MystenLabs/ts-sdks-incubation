// Per-stack PackageRegistry — owned by the L2 Package plugin.
//
// Architecture (ARCHITECTURE.md § Substrate name-blindness): the
// substrate exposes ONLY the generic `defineScopedRefMap<K, V>` factory;
// the package-domain shape (`ResolvedLocalPackage` / `ResolvedKnownPackage`)
// lives here at L2 where it belongs. Two `localPackage(...)` calls in
// the same stack see the same Service instance (one per stack scope),
// so cross-plugin lookups stay consistent and warm-restart verify can
// use the previously-resolved `packageId` as a hint.
//
// Wrapper-service pattern (STYLE_GUIDE §6 / "L2 wrapper-service around
// defineScopedRefMap"): the module-private inner `PackageRefMap` is the
// raw substrate primitive; the publicly-exported `PackageRegistryService`
// is the L2 wrapper that the rest of the plugin (and external siblings)
// yield. Today the wrapper only re-exposes the four substrate ops
// (`set` / `find` / `has` / `entries` + `changes`), but the shape
// matches Coin's wrapper so future plugin-specific lookups (e.g.
// `byPublisher`, `byPackageId`) land in one place instead of every
// consumer reaching into the raw map.

import { Context, Effect, Layer, type Stream } from 'effect';

import {
	defineScopedRefMap,
	type ScopedRefMap,
} from '../../substrate/runtime/scoped-ref-map/index.ts';

/** Resolved package handle for a local (built + published) package. */
export interface ResolvedLocalPackage {
	readonly kind: 'local';
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
	/** Captured object ids — keyed by user-declared name. */
	readonly captured: Readonly<Record<string, string>>;
}

/** Resolved package handle for a known (verify-only) package. */
export interface ResolvedKnownPackage {
	readonly kind: 'known';
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrPlaceholder: string;
}

export type ResolvedPackage = ResolvedLocalPackage | ResolvedKnownPackage;

/** Registry key — the user-declared symbolic package name. Kept as a
 *  type alias (not a brand) because the same string flows verbatim
 *  through `localPackage(name, ...)` / `knownPackage(name, ...)` and
 *  out via `entries()` to consumers (codegen, snapshot identity). */
export type PackageKey = string;

/** L2 wrapper shape — the operations exposed on `PackageRegistryService`.
 *  Today these are a 1:1 re-projection of the substrate primitive's
 *  generic `ScopedRefMap<K, V>`; future plugin-specific lookups land
 *  here without forcing every consumer to learn a new shape. */
export interface PackageRegistry {
	readonly set: (key: PackageKey, value: ResolvedPackage) => Effect.Effect<void>;
	readonly find: (key: PackageKey) => Effect.Effect<ResolvedPackage | null>;
	readonly has: (key: PackageKey) => Effect.Effect<boolean>;
	readonly entries: () => Effect.Effect<ReadonlyArray<readonly [PackageKey, ResolvedPackage]>>;
	readonly changes: Stream.Stream<ReadonlyArray<readonly [PackageKey, ResolvedPackage]>>;
}

// Module-private inner substrate primitive — instantiated once per
// logical registry. The service identity is namespaced by the `name`
// argument; substrate stays name-blind (it sees only `K` and `V`).
const PackageRefMap = defineScopedRefMap<PackageKey, ResolvedPackage>('PackageRegistry');

const wrapRefMap = (refMap: ScopedRefMap<PackageKey, ResolvedPackage>): PackageRegistry => ({
	set: refMap.set,
	find: refMap.find,
	has: refMap.has,
	entries: refMap.entries,
	changes: refMap.changes,
});

/** Context.Service tag for the per-stack `PackageRegistry`. Plugins
 *  yield this in their acquire body. */
export class PackageRegistryService extends Context.Service<
	PackageRegistryService,
	PackageRegistry
>()('@devstack-rewrite/plugins/package/PackageRegistry') {}

/** Scope-bound Layer materializing one `PackageRegistry` per stack
 *  scope. Boot wiring (CLI / e2e) provides this once per stack;
 *  every package/coin/wallet/faucet plugin in the stack yields the
 *  SAME instance via Context. */
export const layerPackageRegistry: Layer.Layer<PackageRegistryService> = Layer.effect(
	PackageRegistryService,
	Effect.gen(function* () {
		const refMap = yield* PackageRefMap.Service;
		return PackageRegistryService.of(wrapRefMap(refMap));
	}),
).pipe(Layer.provide(PackageRefMap.layer));

/** Capability-key constant for the per-stack registry — siblings
 *  (Coin, Action, manifest emitter, faucet strategies) look it up
 *  through the StrategyContributor registry. */
export const PACKAGE_REGISTRY_CAPABILITY_KEY = 'package-registry' as const;
