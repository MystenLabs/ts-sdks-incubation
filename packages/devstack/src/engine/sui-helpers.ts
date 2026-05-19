// Small, allocation-free Sui transaction utilities that recurred verbatim
// across example configs. Lives under `engine/` so user configs and
// internal services reach the same picker through the `/advanced` barrel.

import type { SuiObjectChange } from './shared.js';

/** A `created` object change projected for downstream consumers that
 *  need both the object id and the optional address-owner — primarily
 *  the coin-discovery pass that has to distinguish publisher-owned
 *  TreasuryCaps (mintable) from caps transferred to a shared/object
 *  owner at publish time (read-only). */
export interface CreatedObjectEntry {
	readonly objectId: string;
	readonly objectType: string;
	readonly owner?: string;
}

/** Filter for `pickCreatedByType` — pass exactly one of `suffix`,
 *  `includes`, or `prefix`. `all: true` switches the return shape to
 *  the enumerating `ReadonlyArray<CreatedObjectEntry>` form; default
 *  (`all: false` or omitted) returns the first matching `objectId`
 *  (or `undefined` on no match).
 *
 *  - `suffix` — Move type ends with the given string (e.g.
 *    `'::game::Lobby'`). Stable when the package id is unknown at
 *    config-write time but the trailing `::module::Type` is fixed.
 *  - `includes` — Move type contains the given substring. Useful for
 *    generic wrappers where the type-parameter list lives after a
 *    recognisable head (e.g. `'::coin::TreasuryCap<'`).
 *  - `prefix` — Move type starts with the given string. The natural
 *    fit for "every TreasuryCap published in this tx" sweeps. */
export type PickCreatedByTypeFilter =
	| { readonly suffix: string; readonly includes?: never; readonly prefix?: never; readonly all?: false }
	| { readonly includes: string; readonly suffix?: never; readonly prefix?: never; readonly all?: false }
	| { readonly prefix: string; readonly suffix?: never; readonly includes?: never; readonly all?: false }
	| { readonly prefix: string; readonly suffix?: never; readonly includes?: never; readonly all: true };

/** Return type of `pickCreatedByType` — `string | undefined` for
 *  first-match, `ReadonlyArray<CreatedObjectEntry>` for `all: true`. */
export type PickCreatedByTypeResult<F extends PickCreatedByTypeFilter> = F extends {
	readonly all: true;
}
	? ReadonlyArray<CreatedObjectEntry>
	: string | undefined;

/**
 * Find created objects in a transaction's `objectChanges` whose Move
 * type matches the given filter.
 *
 * Single helper covering the three common shapes — pass exactly one of
 * `suffix`, `includes`, or `prefix`. The default returns the first
 * matching `objectId`; passing `{ prefix, all: true }` switches to the
 * enumerating form that returns every match as a
 * `{ objectId, objectType, owner? }` record. Use the enumerating form
 * when a single publish creates multiple matches you need to walk
 * (e.g. coin discovery scanning every `TreasuryCap<...>`).
 *
 * Owner is propagated when it's an `AddressOwner` (devstack-internal
 * `SuiObjectChange` only surfaces the address form — caps transferred
 * to a shared/object owner land with `owner: undefined`).
 *
 * @example First match (suffix):
 * ```ts
 * const lobbyId = pickCreatedByType(changes, { suffix: '::game::Lobby' });
 * ```
 *
 * @example First match (includes — generic wrappers):
 * ```ts
 * const tcap = pickCreatedByType(changes, { includes: '::coin::TreasuryCap<' });
 * ```
 *
 * @example Enumerate every match (prefix + all):
 * ```ts
 * const caps = pickCreatedByType(changes, {
 *   prefix: '0x2::coin::TreasuryCap<',
 *   all: true,
 * });
 * for (const cap of caps) {
 *   const ownedByPublisher = cap.owner === signer.address;
 *   // ...
 * }
 * ```
 */
export function pickCreatedByType<F extends PickCreatedByTypeFilter>(
	changes: ReadonlyArray<SuiObjectChange>,
	filter: F,
): PickCreatedByTypeResult<F>;
export function pickCreatedByType(
	changes: ReadonlyArray<SuiObjectChange>,
	filter: PickCreatedByTypeFilter,
): string | undefined | ReadonlyArray<CreatedObjectEntry> {
	const matches = (objectType: string): boolean => {
		if ('suffix' in filter && filter.suffix !== undefined) return objectType.endsWith(filter.suffix);
		if ('includes' in filter && filter.includes !== undefined)
			return objectType.includes(filter.includes);
		// `prefix` form (with or without `all`).
		return objectType.startsWith(filter.prefix);
	};

	if (filter.all === true) {
		const out: Array<CreatedObjectEntry> = [];
		for (const c of changes) {
			if (
				c.type === 'created' &&
				'objectType' in c &&
				typeof c.objectType === 'string' &&
				matches(c.objectType)
			) {
				out.push({
					objectId: c.objectId,
					objectType: c.objectType,
					...(c.owner !== undefined ? { owner: c.owner } : {}),
				});
			}
		}
		return out;
	}

	for (const c of changes) {
		if (
			c.type === 'created' &&
			'objectType' in c &&
			typeof c.objectType === 'string' &&
			matches(c.objectType)
		) {
			return c.objectId;
		}
	}
	return undefined;
}

// `0xHEX::module::Witness` with the address allowed to be either a
// `0x`-prefixed hex run (variable length — Sui normalizes addresses to
// 64 hex digits, but allows leading-zero-stripped forms) OR a leading-
// underscore identifier (e.g. `0x0` is canonical; some MVR placeholder
// flows substitute `_pkg`-style names). `module` and `Witness` follow
// the standard Move identifier rule (letter/underscore-led, then
// `[A-Za-z0-9_]*`).
const COIN_TYPE_RE = /^0x[0-9a-fA-F]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the inner coin type out of a wrapper like
 * `0x2::coin::TreasuryCap<0x...::module::Witness>` or
 * `0x2::coin::CoinMetadata<0x...::module::Witness>`. Returns the inner
 * `0x...::module::Witness` string, or `undefined` if the input doesn't
 * match the wrapper or the inner type doesn't structurally look like a
 * coin witness.
 *
 * Nested generics (`0x2::coin::TreasuryCap<0x...::a::A<0x...::b::B>>`)
 * return `undefined` — the discovery pass uses the bare coin-witness
 * form by construction; refusing to disambiguate keeps a coin module
 * with an exotic init shape from silently being treated as a regular
 * coin downstream.
 *
 * @param objectType — the full Move type as emitted by the publish receipt.
 * @param wrapper — either `'0x2::coin::TreasuryCap'` or `'0x2::coin::CoinMetadata'`.
 */
export const parseCoinTypeFromGeneric = (
	objectType: string,
	wrapper: '0x2::coin::TreasuryCap' | '0x2::coin::CoinMetadata',
): string | undefined => {
	const head = `${wrapper}<`;
	if (!objectType.startsWith(head)) return undefined;
	if (!objectType.endsWith('>')) return undefined;
	const inner = objectType.slice(head.length, -1);
	if (inner.length === 0) return undefined;
	// Reject nested generics — discovery only handles bare coin
	// witnesses. A `<` inside `inner` means there's another generic
	// layer; refuse to guess what the caller meant.
	if (inner.includes('<') || inner.includes('>')) return undefined;
	if (!COIN_TYPE_RE.test(inner)) return undefined;
	return inner;
};
