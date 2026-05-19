// Small, allocation-free Sui transaction utilities that recurred verbatim
// across example configs. Lives under `engine/` so user configs and
// internal services reach the same picker through the `/advanced` barrel.

import { normalizeStructTag } from '@mysten/sui/utils';
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
	| {
			readonly suffix: string;
			readonly includes?: never;
			readonly prefix?: never;
			readonly all?: false;
	  }
	| {
			readonly includes: string;
			readonly suffix?: never;
			readonly prefix?: never;
			readonly all?: false;
	  }
	| {
			readonly prefix: string;
			readonly suffix?: never;
			readonly includes?: never;
			readonly all?: false;
	  }
	| {
			readonly prefix: string;
			readonly suffix?: never;
			readonly includes?: never;
			readonly all: true;
	  };

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
		if ('suffix' in filter && filter.suffix !== undefined) {
			if (objectType.endsWith(filter.suffix)) return true;
			return moveTypeEndsWith(objectType, filter.suffix);
		}
		if ('includes' in filter && filter.includes !== undefined) {
			// gRPC normalizes addresses in `objectType` to the
			// 64-zero-padded long form; user-authored substrings often
			// use the short form (e.g. `'0x2::coin::Coin<...>'`). Try
			// the literal substring first (cheap, covers
			// address-segment-free patterns like `'::game::Lobby'`),
			// then fall back to address-form-agnostic matching.
			if (objectType.includes(filter.includes)) return true;
			return moveTypeIncludes(objectType, filter.includes);
		}
		// `prefix` form (with or without `all`). Same canonicalization
		// concern — gRPC long-form vs. user short-form. Defensive
		// fallback to literal `startsWith` covers prefixes that don't
		// carry an address segment (rare in practice).
		return (
			moveTypeStartsWith(objectType, filter.prefix) || objectType.startsWith(filter.prefix)
		);
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

/** Strip leading `0x` and any leading-zero padding so two equivalent
 *  Sui address forms (`0x2` vs `0x0000…0002`, both representing the
 *  same on-chain address) compare equal as canonical-bytes lowercase
 *  hex. gRPC normalizes every address in `objectType` to the
 *  64-zero-padded long form; JSON-RPC and most user-authored constants
 *  use the short stripped form. Comparing via this canonicalization
 *  keeps every consumer (`pickCreatedByType`, `parseCoinTypeFromGeneric`,
 *  the coin auto-discovery prefixes) address-form-agnostic. */
const canonicalAddress = (address: string): string => {
	const lower = address.toLowerCase();
	const bare = lower.startsWith('0x') ? lower.slice(2) : lower;
	const trimmed = bare.replace(/^0+/, '');
	return trimmed.length === 0 ? '0' : trimmed;
};

/** Compare two Move-type strings (`0xADDR::module::Type[...]`) by
 *  canonicalizing the leading `0xADDR` segment on both sides. Returns
 *  the rest of `actual` after the matching address+`::` (i.e. the
 *  position immediately after the address prefix), or `undefined` when
 *  the addresses don't match or the input is malformed. The remainder
 *  is intentionally returned so callers can chain further structural
 *  checks (e.g. `::coin::TreasuryCap<...>`) without re-parsing. */
const stripMatchingAddressPrefix = (actual: string, expected: string): string | undefined => {
	const sep = '::';
	const aSepIdx = actual.indexOf(sep);
	const eSepIdx = expected.indexOf(sep);
	if (aSepIdx === -1 || eSepIdx === -1) return undefined;
	const aAddr = actual.slice(0, aSepIdx);
	const eAddr = expected.slice(0, eSepIdx);
	if (canonicalAddress(aAddr) !== canonicalAddress(eAddr)) return undefined;
	const aRest = actual.slice(aSepIdx);
	const eRest = expected.slice(eSepIdx);
	return aRest.startsWith(eRest) ? aRest.slice(eRest.length) : undefined;
};

/** Address-form-agnostic `startsWith`-equivalent over a Move type
 *  prefix. Both `objectType` and `expectedPrefix` carry an address
 *  segment (`0xADDR::module::...`); the comparison canonicalizes the
 *  address bytes so `0x2::coin::TreasuryCap<` matches an `objectType`
 *  of `0x0000…0002::coin::TreasuryCap<...>` and vice versa.
 *
 *  Used by `pickCreatedByType` (when given a `prefix:` filter) and by
 *  the coin auto-discovery pass so the matcher behaves identically
 *  against JSON-RPC short-form objectTypes and gRPC long-form
 *  objectTypes. */
export const moveTypeStartsWith = (objectType: string, expectedPrefix: string): boolean =>
	stripMatchingAddressPrefix(objectType, expectedPrefix) !== undefined;

/** Address-form-agnostic `includes`-equivalent. Canonicalizes both
 *  sides via the SDK's `normalizeStructTag` (which expands every
 *  address segment to the 64-zero-padded long form) before substring
 *  matching, so a user-authored substring like
 *  `'0x2::coin::Coin<0x...::mock_usdc::MOCK_USDC>'` matches against a
 *  gRPC `objectType` of
 *  `'0x0000…0002::coin::Coin<0x0000…ABC::mock_usdc::MOCK_USDC>'`.
 *
 *  Falls back gracefully (`false`) when either side isn't a valid
 *  struct tag — caller already tried literal `String.includes` so
 *  malformed input doesn't need a second answer here. */
const moveTypeIncludes = (objectType: string, expectedSubstring: string): boolean => {
	try {
		const canonical = normalizeStructTag(objectType);
		const canonicalNeedle = normalizeStructTag(expectedSubstring);
		return canonical.includes(canonicalNeedle);
	} catch {
		return false;
	}
};

/** Address-form-agnostic `endsWith`-equivalent. Same canonicalization
 *  trick as {@link moveTypeIncludes} — `normalizeStructTag` both sides
 *  before comparing. Used by `pickCreatedByType`'s `suffix:` filter
 *  for callsites that build the suffix from a known full type (e.g.
 *  `${packageId}::pool::Pool<${base}, ${quote}>` in deepbook
 *  local-deploy). Falls back to literal `endsWith` first so
 *  `'::game::Lobby'`-style address-free suffixes don't need to parse
 *  as struct tags. */
const moveTypeEndsWith = (objectType: string, expectedSuffix: string): boolean => {
	try {
		const canonical = normalizeStructTag(objectType);
		const canonicalNeedle = normalizeStructTag(expectedSuffix);
		return canonical.endsWith(canonicalNeedle);
	} catch {
		return false;
	}
};

/** Address-form-agnostic Move-type equality. Canonicalizes both via
 *  the SDK's `normalizeStructTag` (expanding short addresses like
 *  `0x2` to the 64-zero-padded long form, and applying the same
 *  recursively to every type-parameter address) before string
 *  comparison. Returns `false` for inputs that fail to parse as a
 *  struct tag — callers can defensively check `actual === expected`
 *  first if they want the strict-equality fallback. */
export const moveTypeEquals = (actual: string, expected: string): boolean => {
	if (actual === expected) return true;
	try {
		return normalizeStructTag(actual) === normalizeStructTag(expected);
	} catch {
		return false;
	}
};

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
	// Address-form-agnostic prefix strip. gRPC publish receipts normalize
	// every address segment to the 64-zero-padded long form
	// (`0x0000…0002::coin::TreasuryCap<...>`); JSON-RPC and the wrapper
	// constants here use the short form (`0x2::coin::TreasuryCap`).
	// Matching the address-bytes canonically keeps both forms working.
	const afterWrapper = stripMatchingAddressPrefix(objectType, wrapper);
	if (afterWrapper === undefined) return undefined;
	if (!afterWrapper.startsWith('<')) return undefined;
	if (!afterWrapper.endsWith('>')) return undefined;
	const inner = afterWrapper.slice(1, -1);
	if (inner.length === 0) return undefined;
	// Reject nested generics — discovery only handles bare coin
	// witnesses. A `<` inside `inner` means there's another generic
	// layer; refuse to guess what the caller meant.
	if (inner.includes('<') || inner.includes('>')) return undefined;
	if (!COIN_TYPE_RE.test(inner)) return undefined;
	return inner;
};
