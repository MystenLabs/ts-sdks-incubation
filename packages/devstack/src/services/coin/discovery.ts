// Coin discovery — pure projection from a publish receipt's
// `objectChanges` into the set of coins (`TreasuryCap` + `CoinMetadata`)
// the publish created.
//
// Background: every `coin::create_currency<W>(witness, decimals, ...)` call
// inside a Move module's `init` emits TWO 'created' object changes:
//   1. `0x2::coin::TreasuryCap<<fullCoinType>>` — the mint capability,
//      typically owned by the publisher post-init.
//   2. `0x2::coin::CoinMetadata<<fullCoinType>>` — a frozen object
//      carrying symbol / name / decimals / iconUrl / description (the
//      RPC payload `client.core.getCoinMetadata` returns).
//
// This pass enumerates both prefixes, parses the inner coin type out of
// each generic wrapper, and cross-references the two by coin type so
// downstream consumers (manifest emission, faucet mint-strategy
// registration, the eventual `Coin('SYMBOL')` factory) can address every
// coin published in one tx without the user re-typing `(name, module,
// type, decimals)` triples in `Package({coins: [...]})`.
//
// Pure function — no Effect, no RPC. The RPC call (`getCoinMetadata`)
// runs at a separate phase via `services/coin/loader.ts`.

import { parseCoinTypeFromGeneric, pickCreatedByType } from '../../engine/sui-helpers.js';
import type { SuiObjectChange } from '../../engine/shared.js';

const TREASURY_CAP_PREFIX = '0x2::coin::TreasuryCap<';
const COIN_METADATA_PREFIX = '0x2::coin::CoinMetadata<';
const TREASURY_CAP_WRAPPER = '0x2::coin::TreasuryCap';
const COIN_METADATA_WRAPPER = '0x2::coin::CoinMetadata';

/** Parsed coin reference derived from a publish receipt.
 *
 *  `coinType` is the canonical `0xPKG::module::Witness` form (i.e. the
 *  inner type parameter of the matching TreasuryCap / CoinMetadata
 *  wrapper). `witnessName` and `moduleName` are derived by string-split
 *  so downstream consumers (e.g. the symbol-keyed registry collision
 *  fallback `${packageId.slice(0,6)}.${witness}`) don't have to
 *  re-parse.
 *
 *  `treasuryCapId` is `undefined` for coins minted via a custom init
 *  that bypasses `coin::create_currency` (rare; the discovery pass
 *  still surfaces such coins via the metadata side when the publisher
 *  emits one).
 *
 *  `treasuryCapOwner` is the post-init address-owner of the cap; when
 *  the publisher transfers the cap at init time (DAO / shared-object
 *  patterns), this won't equal the publisher's address, and
 *  `publisherOwnsCap` flips to `false`. Faucet auto-registration
 *  skips coins where `publisherOwnsCap === false` — the publisher
 *  can't sign a mint tx against a cap they don't hold.
 *
 *  `metadataId` is `undefined` for coins that don't follow the standard
 *  `create_currency` pattern (no `CoinMetadata` object emitted). Such
 *  coins are still recorded with degraded shape; downstream consumers
 *  that need symbol/decimals warn and skip.
 */
export interface DiscoveredCoin {
	readonly coinType: string;
	readonly witnessName: string;
	readonly moduleName: string;
	readonly treasuryCapId?: string;
	readonly treasuryCapOwner?: string;
	readonly metadataId?: string;
	readonly publisherOwnsCap: boolean;
}

/** Split `0xPKG::module::Witness` into `(module, witness)`. Returns
 *  empty strings if the type is malformed — the parsed-type regex in
 *  `parseCoinTypeFromGeneric` already enforces the structural shape, so
 *  malformed input shouldn't reach here in practice. */
const splitCoinType = (
	coinType: string,
): { readonly moduleName: string; readonly witnessName: string } => {
	const parts = coinType.split('::');
	if (parts.length !== 3) return { moduleName: '', witnessName: '' };
	return { moduleName: parts[1] ?? '', witnessName: parts[2] ?? '' };
};

/**
 * Walk a publish receipt's `objectChanges` and return every coin the
 * publish created, cross-referenced between `TreasuryCap` + `CoinMetadata`
 * by parsed coin type. Pure function (no RPC / no IO).
 *
 * Ownership-bearing fields (`treasuryCapOwner`, `publisherOwnsCap`) read
 * the `owner` slot on the `'created'` object change. The devstack
 * `SuiObjectChange` projection only surfaces address-owners (the case
 * we care about for "publisher holds the cap"); caps transferred to
 * shared/object/immutable owners at publish time land with
 * `treasuryCapOwner: undefined` + `publisherOwnsCap: false`.
 *
 * @param changes — the publish transaction's `objectChanges` array.
 * @param publisherAddress — the address of the account that signed the
 *   publish. Used to decide `publisherOwnsCap`.
 */
export const discoverCoinsFromPublish = (
	changes: ReadonlyArray<SuiObjectChange>,
	publisherAddress: string,
): ReadonlyArray<DiscoveredCoin> => {
	// Two-pass collect — first index every cap + metadata by inner coin
	// type, then fold into a single output entry per coin. A single-pass
	// fold would lose the ordering invariant (publish receipts don't
	// guarantee cap-before-metadata), and re-keying by coin type
	// already gives O(1) cross-reference.
	const capByType = new Map<string, { readonly objectId: string; readonly owner?: string }>();
	const metaByType = new Map<string, string>();

	for (const entry of pickCreatedByType(changes, { prefix: TREASURY_CAP_PREFIX, all: true })) {
		const coinType = parseCoinTypeFromGeneric(entry.objectType, TREASURY_CAP_WRAPPER);
		if (coinType === undefined) continue;
		capByType.set(coinType, {
			objectId: entry.objectId,
			...(entry.owner !== undefined ? { owner: entry.owner } : {}),
		});
	}
	for (const entry of pickCreatedByType(changes, { prefix: COIN_METADATA_PREFIX, all: true })) {
		const coinType = parseCoinTypeFromGeneric(entry.objectType, COIN_METADATA_WRAPPER);
		if (coinType === undefined) continue;
		metaByType.set(coinType, entry.objectId);
	}

	// Union the key sets so a coin with only a cap (custom init) or only
	// a metadata (very unusual; cap transferred immediately at init?)
	// still surfaces with degraded fields.
	const allCoinTypes = new Set<string>([...capByType.keys(), ...metaByType.keys()]);
	const out: Array<DiscoveredCoin> = [];
	for (const coinType of allCoinTypes) {
		const cap = capByType.get(coinType);
		const metadataId = metaByType.get(coinType);
		const { moduleName, witnessName } = splitCoinType(coinType);
		const treasuryCapOwner = cap?.owner;
		const publisherOwnsCap =
			cap !== undefined && treasuryCapOwner !== undefined && treasuryCapOwner === publisherAddress;
		out.push({
			coinType,
			witnessName,
			moduleName,
			...(cap?.objectId !== undefined ? { treasuryCapId: cap.objectId } : {}),
			...(treasuryCapOwner !== undefined ? { treasuryCapOwner } : {}),
			...(metadataId !== undefined ? { metadataId } : {}),
			publisherOwnsCap,
		});
	}
	// Stable ordering: ascending by coin type. Callers downstream rely
	// on this for deterministic manifest output across re-runs.
	out.sort((a, b) => a.coinType.localeCompare(b.coinType));
	return out;
};
