// Generic scoped Ref-Map registry primitive.
//
// Architecture (ARCHITECTURE.md § Substrate primitives roster /
// § Substrate name-blindness): a name-blind, per-stack-scoped
// in-memory `K -> V` lookup table. Substrate exposes ONLY the
// generic primitive; L2 plugins (Sui-coin, Move-package, future
// chain plugins) instantiate it with their domain-specific
// `K` and `V` shapes to author their own typed Context.Service.
//
// Why the factory `defineScopedRefMap<K, V>(name)` shape rather
// than a single `ScopedRefMapService` tag:
//
//   - One service per plugin domain — `PackageRegistry`,
//     `CoinRegistry`, etc. — gives each plugin its own typed
//     tag instead of every consumer reaching into a single map
//     and narrowing.
//   - Substrate stays name-blind: it doesn't know `coin` or
//     `package`; it only knows "give me a Layer + Service for
//     `<K, V>`". The plugin chooses the name.
//   - The substrate Service-class identity is the namespace —
//     two `defineScopedRefMap('Foo')` and `defineScopedRefMap('Bar')`
//     calls return distinct services that can coexist in the
//     same scope.
//
// Lifetime: each instantiated service is materialized by a
// Layer that lives for the stack scope. When the scope closes,
// the in-memory `SubscriptionRef` drops with it — the ref is
// closure-private to the Layer's build effect, so the GC
// reclaims it once no subscribers hold the stream.

import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from 'effect';

/** Lookup failure for a missing key. Schema-tagged so consumers
 *  may `Effect.catchTag('ScopedRefMapKeyMissingError', ...)` and
 *  the cascade-formatter can render it without importing the class. */
export class ScopedRefMapKeyMissingError extends Schema.TaggedErrorClass<ScopedRefMapKeyMissingError>()(
	'ScopedRefMapKeyMissingError',
	{
		registryName: Schema.String,
		key: Schema.String,
	},
) {}

/** Operations on a scoped `K -> V` ref-map. Generic over `K`
 *  (constrained to `string`-shaped brands so it can be used as
 *  a Map key) and `V` (fully opaque to substrate). */
export interface ScopedRefMap<K extends string, V> {
	/** Insert / overwrite. Last-write-wins on `K`. */
	readonly set: (key: K, value: V) => Effect.Effect<void>;
	/** Strict lookup. Fails with `ScopedRefMapKeyMissingError`
	 *  when the key isn't present. */
	readonly get: (key: K) => Effect.Effect<V, ScopedRefMapKeyMissingError>;
	/** Non-failing lookup — `null` when absent. */
	readonly find: (key: K) => Effect.Effect<V | null>;
	/** Presence check without an error projection. */
	readonly has: (key: K) => Effect.Effect<boolean>;
	/** Snapshot of all `(key, value)` pairs. Iteration order is
	 *  insertion order. */
	readonly entries: () => Effect.Effect<ReadonlyArray<readonly [K, V]>>;
	/** Stream of full-snapshot states. Each emission is the
	 *  current `entries` array; consumers diff if they need
	 *  incremental updates. */
	readonly changes: Stream.Stream<ReadonlyArray<readonly [K, V]>>;
}

/**
 * Factory: declare a typed `K -> V` scoped ref-map service.
 *
 * The `name` becomes both the human-readable registry name (used
 * in `ScopedRefMapKeyMissingError.registryName`) and the
 * Context.Service identifier (prefixed with the substrate
 * namespace). Each call returns a fresh Service class; calling
 * twice with the same name produces two distinct services
 * (Context.Service identity is per-class, not per-id-string —
 * the id string is a debugging aid).
 *
 * Return shape — typed via inference so the inner Service class's
 * identity flows through to callers:
 *   - `Service` — the `Context.Service` tag class. Plugin authors
 *     yield this from their `acquire` body via `yield* MyRegistry.Service`.
 *   - `layer` — scope-bound Layer constructing one ref-map per
 *     stack scope.
 *   - `changes` — stream helper mirroring `routesStream(router)`.
 *
 * Example (in an L2 plugin):
 *
 * ```ts
 * const PackageRegistry = defineScopedRefMap<PackageKey, PackageRecord>('PackageRegistry');
 *
 * // In the plugin's acquire body:
 * const registry = yield* PackageRegistry.Service;
 * yield* registry.set(name, resolved);
 *
 * // In the boot Layer:
 * Layer.mergeAll(PackageRegistry.layer, ...)
 * ```
 */
export const defineScopedRefMap = <K extends string, V>(name: string) => {
	const serviceId = `@devstack-rewrite/substrate/ScopedRefMap/${name}`;

	class Service extends Context.Service<Service, ScopedRefMap<K, V>>()(serviceId) {}

	const layer: Layer.Layer<Service> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const ref = yield* SubscriptionRef.make<ReadonlyArray<readonly [K, V]>>([]);

			const set: ScopedRefMap<K, V>['set'] = (key, value) =>
				SubscriptionRef.update(ref, (current) => {
					const filtered = current.filter(([k]) => k !== key);
					return [...filtered, [key, value] as const];
				});

			const find: ScopedRefMap<K, V>['find'] = (key) =>
				SubscriptionRef.get(ref).pipe(
					Effect.map((current) => {
						const hit = current.find(([k]) => k === key);
						return hit ? hit[1] : null;
					}),
				);

			const get: ScopedRefMap<K, V>['get'] = (key) =>
				Effect.gen(function* () {
					const value = yield* find(key);
					if (value === null) {
						return yield* new ScopedRefMapKeyMissingError({
							registryName: name,
							key,
						});
					}
					return value;
				});

			const has: ScopedRefMap<K, V>['has'] = (key) =>
				SubscriptionRef.get(ref).pipe(Effect.map((current) => current.some(([k]) => k === key)));

			const entries: ScopedRefMap<K, V>['entries'] = () => SubscriptionRef.get(ref);

			return Service.of({
				set,
				get,
				find,
				has,
				entries,
				changes: SubscriptionRef.changes(ref),
			});
		}),
	);

	const changes = (svc: ScopedRefMap<K, V>): Stream.Stream<ReadonlyArray<readonly [K, V]>> =>
		svc.changes;

	return {
		Service,
		layer,
		changes,
	} as const;
};
