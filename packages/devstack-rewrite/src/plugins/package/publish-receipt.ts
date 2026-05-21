// Publish-receipt shape + receipt-projection helpers.
//
// The walker that folds the receipt into CoinRegistry rows lives in
// `plugins/coin/discovery.ts` — discovery / metadata enrichment are
// projections over the receipt and belong with the Coin plugin
// (distilled doc §Cross-component references §coin). This file owns
// only the shape definitions and the `pickPublishedChange` /
// `pickUpgradeCapChange` projection helpers — both consumed by the
// package's own publish-tx executor.
//
// Open slot O5 — STYLE_GUIDE §7, ARCHITECTURE.md "Plugin A ↔ Plugin B
// coupling". The coin plugin imports `PublishReceipt` /
// `PublishObjectChange` from this file (`plugins/coin/discovery.ts` →
// `../package/index.ts` → re-export from here). The substrate-correct
// fix is to LIFT the `PublishReceipt` shape into substrate/contracts
// (or substrate/runtime/event-bus) and have package RAISE a
// `PublishReceiptEmitted` event that coin SUBSCRIBES to — eliminating
// the L2-to-L2 import. Pending PR2-A's harvest loop OR a generic
// event-bus primitive.

/** SDK-typed object change from the publish receipt. Trimmed to
 *  what consumers need; the full shape lives in `@mysten/sui`. */
export interface PublishObjectChange {
	readonly type: 'created' | 'published' | 'mutated' | 'wrapped' | 'transferred';
	readonly objectId?: string;
	readonly objectType?: string;
	readonly owner?: unknown;
}

/** Publish receipt — the projection of `SuiTransactionBlockResponse`
 *  that downstream consumers (Coin discovery, capture spec, the
 *  manifest emitter) need.
 *
 *  Exposed on the resolved value of a `LocalPackage` plugin (see
 *  `service.ts`); the Coin plugin's acquire reads it via the
 *  package tag's resolved shape.
 *
 *  KnownPackage has NO receipt — the type split in `service.ts`
 *  ensures consumers requiring a receipt cannot consume a known
 *  package tag (compile error, per distilled doc Invariant 9). */
export interface PublishReceipt {
	readonly digest: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly publisher: string;
	readonly objectChanges: ReadonlyArray<PublishObjectChange>;
}

/** Helper: pick the `'published'` change from a receipt to recover
 *  the package id. Distilled doc §Move-specific concerns. Used by
 *  `mode-local.ts` to parse the post-publish receipt; exposed here
 *  so the Coin plugin can reuse the same pick logic via cross-plugin
 *  re-export. */
export const pickPublishedChange = (
	changes: ReadonlyArray<PublishObjectChange>,
): PublishObjectChange | undefined => changes.find((c) => c.type === 'published');

/** Helper: pick the upgrade-cap `'created'` change. */
export const pickUpgradeCapChange = (
	changes: ReadonlyArray<PublishObjectChange>,
): PublishObjectChange | undefined =>
	changes.find(
		(c) => c.type === 'created' && (c.objectType?.endsWith('::package::UpgradeCap') ?? false),
	);
