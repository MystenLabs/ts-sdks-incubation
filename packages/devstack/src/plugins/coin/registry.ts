// Per-stack CoinRegistry — owned by the L2 Coin plugin.
//
// Architecture (ARCHITECTURE.md § Substrate name-blindness): the
// substrate exposes ONLY the generic `ScopedRefMap<K, V>` primitive;
// each L2 plugin instantiates it with its own domain shape. The
// `CoinRecord` shape below carries Sui/Move-coin concepts
// (`witness`, `treasuryCapId`, `metadataId`, `packageId`,
// `mvrPlaceholder`, `publishingPackageName`, `moduleName`) — those
// are L2 concerns, not substrate.
//
// The five Sui-specific lookup shapes (`bySymbol`, `byWitness`,
// `byType`, `list`, `register`) live on the L2 `CoinRegistry`
// wrapper. The underlying generic primitive only knows `K -> V`;
// the wrapper iterates the snapshot for the symbol / witness /
// type-based queries (cardinality is bounded by declared coins
// per stack, typically < 10).
//
// Lifetime: one instance per stack scope (the generic primitive's
// `layer` is scope-bound). Plugins yield `CoinRegistryService`
// from their `acquire` body; the boot wiring (CLI / e2e) provides
// the resolved instance once per stack.

import { Context, Effect, Layer } from 'effect';

import {
	defineScopedRefMap,
	type ScopedRefMap,
} from '../../substrate/runtime/scoped-ref-map/index.ts';

/** Discovered-coin record — the value-shape stored in the registry.
 *  Superset of the published-coin shape with discovery-populated
 *  metadata fields. */
export interface CoinRecord {
	/** Registry key — the discovered CoinMetadata symbol, falling
	 *  back to the witness name when metadata is absent. Always
	 *  lower-cased for case-insensitive lookups (the original-case
	 *  `symbol` field carries the display form). */
	readonly key: string;
	/** Fully-qualified on-chain type — `0xPKG::module::Witness`. */
	readonly type: string;
	/** Lower-cased witness identifier (e.g. `mock_usdc`). Used for
	 *  the `coin.fromPackage(pkg, 'MOCK_USDC')` lookup. */
	readonly witness: string;
	/** Lower-cased module name. */
	readonly moduleName: string;
	/** `0` when CoinMetadata absent. */
	readonly decimals: number;
	/** Display-case symbol from CoinMetadata. Absent when metadata
	 *  fetch failed / coin had no CoinMetadata. */
	readonly symbol?: string;
	readonly displayName?: string;
	readonly iconUrl?: string;
	/** Present when the publisher held the cap at publish time AND
	 *  the cap is still address-owned. */
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	/** The publishing package's id — load-bearing for the
	 *  package-scoped witness lookup. */
	readonly packageId: string;
	/** Source-of-truth name of the publishing package (the Package
	 *  plugin's symbolic name, NOT the on-chain packageId). Used to
	 *  format error messages and drive the codegen emitter's
	 *  per-package grouping. */
	readonly publishingPackageName: string;
}

/** Registry key — the fully-qualified on-chain coin type. Branded so
 *  the generic primitive's `K extends string` constraint applies
 *  without leaking the brand to substrate. */
export type CoinKey = string & { readonly _brand: 'CoinKey' };

const coinKey = (fullCoinType: string): CoinKey => fullCoinType as CoinKey;

/** Per-stack registry of all discovered coins. The five lookup
 *  shapes are Sui-specific projections over a generic `K -> V`
 *  scope-bound ref-map. */
export interface CoinRegistry {
	readonly register: (record: CoinRecord) => Effect.Effect<void>;
	readonly bySymbol: (symbol: string) => Effect.Effect<ReadonlyArray<CoinRecord>>;
	readonly byWitness: (packageName: string, witness: string) => Effect.Effect<CoinRecord | null>;
	readonly byType: (fullCoinType: string) => Effect.Effect<CoinRecord | null>;
	readonly list: () => Effect.Effect<ReadonlyArray<CoinRecord>>;
}

// Generic substrate primitive — instantiated once per logical
// registry. The service identity is namespaced by the `name`
// argument; substrate stays name-blind (it sees only `K` and `V`).
const CoinRefMap = defineScopedRefMap<CoinKey, CoinRecord>('CoinRegistry');

const wrapRefMap = (refMap: ScopedRefMap<CoinKey, CoinRecord>): CoinRegistry => ({
	register: (record) => refMap.set(coinKey(record.type), record),
	bySymbol: (symbol) =>
		refMap.entries().pipe(
			Effect.map((entries) => {
				const lowered = symbol.toLowerCase();
				return entries
					.map(([, r]) => r)
					.filter((r) => r.key === lowered || r.symbol?.toLowerCase() === lowered);
			}),
		),
	byWitness: (packageName, witness) =>
		refMap.entries().pipe(
			Effect.map((entries) => {
				const lowered = witness.toLowerCase();
				return (
					entries
						.map(([, r]) => r)
						.find(
							(r) =>
								r.publishingPackageName === packageName &&
								(r.witness === lowered || r.symbol?.toLowerCase() === lowered),
						) ?? null
				);
			}),
		),
	byType: (fullCoinType) =>
		refMap.find(coinKey(fullCoinType)).pipe(Effect.map((hit) => hit ?? null)),
	list: () => refMap.entries().pipe(Effect.map((entries) => entries.map(([, r]) => r))),
});

/** Context.Service tag for the per-stack `CoinRegistry`. Plugins
 *  yield this in their acquire body. */
export class CoinRegistryService extends Context.Service<CoinRegistryService, CoinRegistry>()(
	'@devstack/plugins/coin/CoinRegistry',
) {}

/** Scope-bound Layer materializing one `CoinRegistry` per stack
 *  scope. Boot wiring (CLI / e2e) provides this once per stack;
 *  every coin/package/wallet/faucet plugin in the stack yields the
 *  SAME instance via Context. */
export const layerCoinRegistry: Layer.Layer<CoinRegistryService> = Layer.effect(
	CoinRegistryService,
	Effect.gen(function* () {
		const refMap = yield* CoinRefMap.Service;
		return CoinRegistryService.of(wrapRefMap(refMap));
	}),
).pipe(Layer.provide(CoinRefMap.layer));
