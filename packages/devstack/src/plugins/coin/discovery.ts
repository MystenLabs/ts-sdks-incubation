// Coin auto-discovery — pure projection over a `LocalPackagePublishOutput`.
//
// Distilled-doc 13-coin.md §"Capabilities PRODUCED" §"Registry
// entries" + Invariant 6 + Invariant 7:
//
//   - Iterate `output.objectChanges`,
//   - Find paired Sui-framework `coin::TreasuryCap<T>` +
//     `coin::CoinMetadata<T>`,
//   - Reject nested generics (`TreasuryCap<A<B>>` returns no record),
//   - Sort ascending by fullCoinType for deterministic order.
//
// This file is PURE — no Effect, no RPC. Metadata enrichment (the
// `getCoinMetadata` RPC fold) lives in `metadata.ts`; we just emit
// the raw discovered shape here. The input is structural so Coin does
// not import Package internals.

export interface CoinDiscoveryObjectChange {
	readonly type: 'created' | 'published' | 'mutated' | 'wrapped' | 'transferred';
	readonly objectId?: string;
	readonly objectType?: string;
	readonly owner?: unknown;
}

export interface CoinDiscoveryPublishOutput {
	readonly publisher: string;
	readonly objectChanges: ReadonlyArray<CoinDiscoveryObjectChange>;
}

/** A discovered coin pulled out of a publish output. The downstream
 *  metadata enricher in `metadata.ts` turns this into a full
 *  `CoinRecord`. */
export interface DiscoveredCoin {
	/** `0xPKG::module::Witness`. */
	readonly fullCoinType: string;
	/** Lower-cased witness name. */
	readonly witness: string;
	/** Lower-cased module name. */
	readonly moduleName: string;
	readonly treasuryCapId?: string;
	readonly treasuryCapOwner?: string;
	readonly metadataId?: string;
	/** True when the cap is address-owned by the publisher at the
	 *  end of the publish tx. Distilled-doc invariant: the faucet's
	 *  treasury-cap-mint auto-registration is gated off this flag. */
	readonly publisherOwnsCap: boolean;
}

const normalizeSuiAddress = (address: string): string | null => {
	if (!address.startsWith('0x')) return null;
	const hex = address.slice(2).toLowerCase();
	if (!/^[0-9a-f]+$/.test(hex)) return null;
	return `0x${hex.replace(/^0+/, '') || '0'}`;
};

/** Parse the inner generic out of Sui-framework
 *  `coin::TreasuryCap<INNER>` / `coin::CoinMetadata<INNER>`. The SDK
 *  may spell the framework address as `0x2` or fully padded
 *  `0x000...0002`; normalize before matching. Returns `null` if the
 *  inner generic itself carries angle brackets (nested generic —
 *  distilled-doc invariant 7: refuse to guess). */
const pickInnerGeneric = (objectType: string, wrapperName: string): string | null => {
	if (!objectType.endsWith('>')) return null;
	const firstSep = objectType.indexOf('::');
	const secondSep = objectType.indexOf('::', firstSep + 2);
	if (firstSep === -1 || secondSep === -1) return null;
	const address = objectType.slice(0, firstSep);
	const moduleName = objectType.slice(firstSep + 2, secondSep);
	const rest = objectType.slice(secondSep + 2);
	if (normalizeSuiAddress(address) !== '0x2') return null;
	if (moduleName !== 'coin') return null;
	const wrapperPrefix = `${wrapperName}<`;
	if (!rest.startsWith(wrapperPrefix)) return null;
	const inner = rest.slice(wrapperPrefix.length, -1);
	// Distilled-doc invariant 7: nested generic is unsupported.
	if (inner.includes('<') || inner.includes('>')) return null;
	// Sanity: a coin type is `0xHEX::module::Witness`.
	const parts = inner.split('::');
	if (parts.length !== 3) return null;
	const [head] = parts;
	if (head === undefined || !head.startsWith('0x')) return null;
	return inner;
};

/** Extract module + witness from `0xPKG::module::Witness`. */
const splitCoinType = (
	fullCoinType: string,
): { readonly moduleName: string; readonly witness: string } | null => {
	const parts = fullCoinType.split('::');
	if (parts.length !== 3) return null;
	const [, moduleName, witness] = parts;
	if (moduleName === undefined || witness === undefined) return null;
	return { moduleName, witness };
};

/** Read the address owner from a package-publish-output change. Handles
 *  the SDK's discriminated owner-shape; non-address owners surface as
 *  `undefined`. The owner shape varies across SDK versions; this
 *  helper covers the common surface and degrades gracefully. */
const pickAddressOwner = (change: CoinDiscoveryObjectChange): string | undefined => {
	const owner = change.owner as
		| { readonly AddressOwner?: string; readonly $kind?: string }
		| string
		| undefined;
	if (owner === undefined || owner === null) return undefined;
	if (typeof owner === 'string') return owner; // some SDK projections flatten
	if (typeof owner === 'object' && 'AddressOwner' in owner) {
		return owner.AddressOwner;
	}
	return undefined;
};

/** Walk a publish output for coin pairs.
 *
 *  Sort ascending by fullCoinType — distilled-doc invariant 6 — so
 *  the registry sees a stable order across re-runs of the same
 *  publish.
 *
 *  Pure. No Effect / RPC. */
export const discoverCoinsFromPublish = (
	output: CoinDiscoveryPublishOutput,
): ReadonlyArray<DiscoveredCoin> => {
	const publisher = output.publisher;
	// Two passes over the changes: collect caps, collect metadata,
	// then JOIN on fullCoinType. The straightforward "iterate once and
	// build per-coin records" is harder to read when the two object
	// types interleave in the output.
	const caps = new Map<string, { readonly id: string; readonly owner: string | undefined }>();
	const metadata = new Map<string, string>();

	for (const change of output.objectChanges) {
		if (change.type !== 'created') continue;
		if (!change.objectType) continue;
		const capInner = pickInnerGeneric(change.objectType, 'TreasuryCap');
		if (capInner !== null && change.objectId !== undefined) {
			caps.set(capInner, {
				id: change.objectId,
				owner: pickAddressOwner(change),
			});
			continue;
		}
		const metaInner = pickInnerGeneric(change.objectType, 'CoinMetadata');
		if (metaInner !== null && change.objectId !== undefined) {
			metadata.set(metaInner, change.objectId);
		}
	}

	// Union the two sets of coin types — a coin with only a cap or
	// only metadata is still a coin (distilled-doc invariant: we
	// surface degraded records rather than drop them).
	const allTypes = new Set<string>([...caps.keys(), ...metadata.keys()]);
	const records: Array<DiscoveredCoin> = [];
	for (const fullCoinType of allTypes) {
		const parts = splitCoinType(fullCoinType);
		if (!parts) continue;
		const cap = caps.get(fullCoinType);
		const metaId = metadata.get(fullCoinType);
		const publisherOwnsCap = cap !== undefined && cap.owner === publisher;
		records.push({
			fullCoinType,
			witness: parts.witness.toLowerCase(),
			moduleName: parts.moduleName.toLowerCase(),
			treasuryCapId: cap?.id,
			treasuryCapOwner: cap?.owner,
			metadataId: metaId,
			publisherOwnsCap,
		});
	}
	// Distilled-doc invariant 6: ascending sort by fullCoinType. Stable
	// across re-runs so the "first wins on collision" tie-break is
	// deterministic.
	records.sort((a, b) =>
		a.fullCoinType < b.fullCoinType ? -1 : a.fullCoinType > b.fullCoinType ? 1 : 0,
	);
	return records;
};
