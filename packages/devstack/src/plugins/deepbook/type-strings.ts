// DeepBook type-string helpers.
//
// Mirrors `plugins/coin/type-strings.ts`: a position-aware matcher over
// a fully-qualified Sui type string instead of substring sniffing.
//
// The coin helper is anchored to the framework `0x2::coin::<Wrapper><T>`
// (single inner generic). A DeepBook pool object is
// `<pkg>::pool::Pool<Base, Quote>` — a NON-framework package with TWO
// positional generic arguments — so it needs its own parser. Both
// arguments and the spec coin types are normalized with the shared SDK
// `normalizeStructTag` (which recursively pads addresses) and compared
// POSITIONALLY, so a reversed pair (`DEEP/SUI` vs `SUI/DEEP`) or a coin
// type that is a substring of another cannot cross-match.

import { normalizeStructTag } from '@mysten/sui/utils';

/** Parse the two positional generic arguments out of a
 *  `<pkg>::pool::Pool<Base, Quote>` object type. Returns `null` when the
 *  type is not a `::pool::Pool<…>` with exactly two top-level arguments
 *  (the SDK may pad the package address, so the module/wrapper suffix is
 *  matched on the `::pool::Pool<` marker rather than the full prefix). */
export const parsePoolGenericArgs = (
	objectType: string,
): { readonly base: string; readonly quote: string } | null => {
	if (!objectType.endsWith('>')) return null;
	const marker = '::pool::Pool<';
	const markerIndex = objectType.indexOf(marker);
	if (markerIndex === -1) return null;
	const inner = objectType.slice(markerIndex + marker.length, -1);
	const args = splitTopLevelGenericArgs(inner);
	if (args.length !== 2) return null;
	const [base, quote] = args;
	if (base === undefined || quote === undefined) return null;
	return { base, quote };
};

/** Does `objectType` name a `Pool<Base, Quote>` whose generic arguments
 *  match `(baseCoinType, quoteCoinType)` POSITIONALLY? Each side is
 *  compared via `normalizeStructTag` so framework-address padding does
 *  not defeat the match and a reversed pair does not collide. */
export const isPoolForPair = (
	objectType: string,
	baseCoinType: string,
	quoteCoinType: string,
): boolean => {
	const parsed = parsePoolGenericArgs(objectType);
	if (parsed === null) return false;
	const base = normalizeStructTagSafe(parsed.base);
	const quote = normalizeStructTagSafe(parsed.quote);
	const wantBase = normalizeStructTagSafe(baseCoinType);
	const wantQuote = normalizeStructTagSafe(quoteCoinType);
	// A malformed tag normalizes to `null`; never let two nulls compare
	// equal — a doubly-malformed side must NOT spuriously pair.
	if (base === null || quote === null || wantBase === null || wantQuote === null) return false;
	return base === wantBase && quote === wantQuote;
};

/** Split a generic-argument list on top-level commas, respecting nested
 *  `<…>` so a generic coin type argument is not split mid-bracket. */
const splitTopLevelGenericArgs = (inner: string): ReadonlyArray<string> => {
	const args: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (ch === '<') depth += 1;
		else if (ch === '>') depth -= 1;
		else if (ch === ',' && depth === 0) {
			args.push(inner.slice(start, i).trim());
			start = i + 1;
		}
	}
	args.push(inner.slice(start).trim());
	return args;
};

/** `normalizeStructTag` throws on a malformed tag; coerce to a sentinel
 *  so a bad parse fails the positional compare rather than the caller. */
const normalizeStructTagSafe = (tag: string): string | null => {
	try {
		return normalizeStructTag(tag);
	} catch {
		return null;
	}
};
