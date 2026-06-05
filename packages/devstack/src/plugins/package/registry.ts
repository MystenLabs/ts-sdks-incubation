// Per-stack PackageRegistry — owned by the L2 Package plugin.
//
// The package-domain shape (`ResolvedLocalPackage` /
// `ResolvedKnownPackage`) lives here at L2 where it belongs. Two
// `localPackage(...)` calls in the same stack see the same Service
// instance (one per stack scope), so cross-plugin lookups stay
// consistent and warm-restart verify can use the previously-resolved
// `packageId` as a hint.
//
// Storage: a self-contained last-write-wins `PackageKey ->
// ResolvedPackage` map over a plain `Ref<Map>` (formerly the
// substrate `defineScopedRefMap` single mode, which had exactly two
// consumers — coin + package — so it was strangled out and inlined
// here). LWW semantics: each `set` stamps a fresh monotonic `seq`
// and replaces the key's lone entry (one entry per key); `entries`
// orders keys by their entry's seq, so a re-set advances the key's
// seq and sorts it to the end.

import { Context, Effect, Layer, Ref } from 'effect';

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

/** L2 registry shape — the operations exposed on
 *  `PackageRegistryService`. A last-write-wins `PackageKey ->
 *  ResolvedPackage` map, namespaced to the package domain so
 *  consumers share one shape. */
export interface PackageRegistry {
	readonly set: (key: PackageKey, value: ResolvedPackage) => Effect.Effect<void>;
	readonly find: (key: PackageKey) => Effect.Effect<ResolvedPackage | null>;
	readonly entries: () => Effect.Effect<ReadonlyArray<readonly [PackageKey, ResolvedPackage]>>;
}

/** One stored entry: the package plus the monotonic `seq` the last
 *  `set` stamped it with. The `seq` drives last-write-wins (highest
 *  seq under a key wins) and `entries` insertion order. */
interface SeqEntry {
	readonly value: ResolvedPackage;
	readonly seq: number;
}

/** Build a self-contained last-write-wins `PackageKey ->
 *  ResolvedPackage` registry over a plain `Ref<Map>`. One entry per
 *  key (each `set` replaces the key's lone entry under a fresh seq),
 *  and `entries` returns pairs ordered by their entry's seq — a
 *  re-set of an existing key advances its seq and re-sorts it to the
 *  end. */
const makePackageRegistry = (): Effect.Effect<PackageRegistry> =>
	Effect.gen(function* () {
		const store = yield* Ref.make<ReadonlyMap<PackageKey, SeqEntry>>(new Map());
		const seqRef = yield* Ref.make(0);

		return {
			set: (key, value) =>
				Effect.gen(function* () {
					const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
					yield* Ref.update(store, (current) => {
						const next = new Map(current);
						next.set(key, { value, seq });
						return next;
					});
				}),
			find: (key) => Ref.get(store).pipe(Effect.map((state) => state.get(key)?.value ?? null)),
			entries: () =>
				Ref.get(store).pipe(
					Effect.map((state) =>
						[...state.entries()]
							.sort(([, a], [, b]) => a.seq - b.seq)
							.map(([key, e]) => [key, e.value] as const),
					),
				),
		};
	});

/** Context.Service tag for the per-stack `PackageRegistry`. Plugins
 *  yield this in their acquire body. */
export class PackageRegistryService extends Context.Service<
	PackageRegistryService,
	PackageRegistry
>()('@devstack/plugins/package/PackageRegistry') {}

/** Scope-bound Layer materializing one `PackageRegistry` per stack
 *  scope. Boot wiring (CLI / e2e) provides this once per stack;
 *  every package/coin/wallet/faucet plugin in the stack yields the
 *  SAME instance via Context. */
export const layerPackageRegistry: Layer.Layer<PackageRegistryService> = Layer.effect(
	PackageRegistryService,
	makePackageRegistry().pipe(Effect.map(PackageRegistryService.of)),
);

/** Capability-key constant for the per-stack registry — siblings
 *  (Coin, Action, manifest emitter, faucet strategies) look it up
 *  through the StrategyContributor registry. */
export const PACKAGE_REGISTRY_CAPABILITY_KEY = 'package-registry' as const;
