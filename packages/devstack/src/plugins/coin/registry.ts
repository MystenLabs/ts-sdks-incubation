// Per-stack CoinRegistry — owned by the L2 Coin plugin.
//
// Architecture (ARCHITECTURE.md § Substrate name-blindness): the
// `CoinRecord` shape below carries Sui/Move-coin concepts
// (`witness`, `treasuryCapId`, `metadataId`, `packageId`,
// `mvrPlaceholder`, `publishingPackageName`, `moduleName`) — those
// are L2 concerns, not substrate.
//
// The four Sui-specific lookup shapes (`byWitness`, `byType`,
// `list`, `register`) live on the L2 `CoinRegistry` wrapper, backed
// by a self-contained last-write-wins `CoinKey -> CoinRecord` map
// over a plain `Ref<Map>`. The wrapper iterates the snapshot for the
// witness / type-based queries (cardinality is bounded by declared
// coins per stack, typically < 10).
//
// LWW semantics (formerly the substrate `defineScopedRefMap` single
// mode): each `set` stamps a fresh monotonic `seq` and replaces the
// key's lone entry (one entry per key), so `list`/`entries` order
// keys by their seq — a re-set advances the key's seq and sorts it
// to the end. Self-contained here because the substrate primitive
// had exactly two consumers (coin + package); duplicating ~30 lines
// of LWW twice deletes a shared substrate abstraction.
//
// Lifetime: one instance per stack scope (the backing `Ref` lives
// in the Layer build effect's scope). Plugins yield
// `CoinRegistryService` from their `acquire` body; the boot wiring
// (CLI / e2e) provides the resolved instance once per stack.

import { Context, Effect, Layer, Ref } from 'effect';

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
 *  it serves as a `Map` key without the brand leaking elsewhere. */
export type CoinKey = string & { readonly _brand: 'CoinKey' };

const coinKey = (fullCoinType: string): CoinKey => fullCoinType as CoinKey;

/** Per-stack registry of all discovered coins. The four lookup
 *  shapes are Sui-specific projections over the LWW `CoinKey ->
 *  CoinRecord` map. */
export interface CoinRegistry {
	readonly register: (record: CoinRecord) => Effect.Effect<void>;
	readonly byWitness: (packageName: string, witness: string) => Effect.Effect<CoinRecord | null>;
	readonly byType: (fullCoinType: string) => Effect.Effect<CoinRecord | null>;
	readonly list: () => Effect.Effect<ReadonlyArray<CoinRecord>>;
}

/** One stored entry: the `CoinRecord` plus the monotonic `seq` the
 *  last `register` stamped it with. The `seq` drives last-write-wins
 *  (highest seq under a key wins) and insertion order (`list` sorts
 *  keys by seq). */
interface SeqEntry {
	readonly value: CoinRecord;
	readonly seq: number;
}

/** Build a self-contained last-write-wins `CoinKey -> CoinRecord`
 *  registry over a plain `Ref<Map>`. One entry per key (each
 *  `register` replaces the key's lone entry under a fresh seq), and
 *  `list` returns records ordered by their entry's seq — a re-set of
 *  an existing key advances its seq and re-sorts it to the end. */
const makeCoinRegistry = (): Effect.Effect<CoinRegistry> =>
	Effect.gen(function* () {
		const store = yield* Ref.make<ReadonlyMap<CoinKey, SeqEntry>>(new Map());
		const seqRef = yield* Ref.make(0);

		const set = (key: CoinKey, value: CoinRecord): Effect.Effect<void> =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				yield* Ref.update(store, (current) => {
					const next = new Map(current);
					next.set(key, { value, seq });
					return next;
				});
			});

		/** Records in insertion order — keys sorted by their entry's seq
		 *  (a re-set sorts to the end). */
		const ordered = (state: ReadonlyMap<CoinKey, SeqEntry>): ReadonlyArray<CoinRecord> =>
			[...state.values()].sort((a, b) => a.seq - b.seq).map((e) => e.value);

		return {
			register: (record) => set(coinKey(record.type), record),
			byWitness: (packageName, witness) =>
				Ref.get(store).pipe(
					Effect.map((state) => {
						const lowered = witness.toLowerCase();
						return (
							ordered(state).find(
								(r) =>
									r.publishingPackageName === packageName &&
									(r.witness === lowered || r.symbol?.toLowerCase() === lowered),
							) ?? null
						);
					}),
				),
			byType: (fullCoinType) =>
				Ref.get(store).pipe(Effect.map((state) => state.get(coinKey(fullCoinType))?.value ?? null)),
			list: () => Ref.get(store).pipe(Effect.map(ordered)),
		};
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
	makeCoinRegistry().pipe(Effect.map(CoinRegistryService.of)),
);
