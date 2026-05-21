// Coin address-resolution — the four user-facing forms unified.
//
// Distilled-doc 13-coin.md §Configuration: the user-facing
// `coin(...)` factory takes one of FOUR address forms. Each form
// resolves to a `ResolvedCoin` (the Tag's resolved value):
//
//   1. **Symbol** — `coin.local('mUSDC')`. Registry lookup. NO dep
//      edge on the publisher; the user is responsible for putting
//      the publishing `localPackage(...)` in compose ordering.
//      (Distilled-doc 13-coin.md Pain point #4: this is a footgun, but
//      the alternative — auto-deriving a dep edge — requires the
//      registry to carry tag identities, which is a layering
//      violation; documented warning in `index.ts` instead.)
//
//   2. **Package-scoped witness** — `coin.fromPackage(pkg, 'MOCK_USDC')`.
//      Forces a dep edge on the publishing `Package`'s tag, then
//      reads its publish receipt's discovered coins. Statically typed
//      against local packages only (KnownPackages have no receipt).
//
//   3. **Bare on-chain type** — `coin.known('0x...::DEEP::DEEP')`.
//      Bypasses the registry; calls `getCoinMetadata` against the
//      resolved Sui client. Use for live-net coins (mainnet DEEP).
//
//   4. **Builtin SUI** — `coin.builtin('sui')`. Pure constant.
//      Resolves to `0x2::sui::SUI` with `decimals: 9` synchronously.
//
// Each form returns a `ResolvedCoin` carrying the same shape so
// downstream consumers (Wallet balance UI, Faucet treasury-cap mint,
// Deepbook market maker) see one consistent value.

import { Effect } from 'effect';

import { coinError, type CoinError } from './errors.ts';
import {
	fetchCoinMetadataOnce,
	isBareCoinType,
	validateBareCoinType,
	type MetadataSdkShim,
} from './metadata.ts';
import type { CoinRecord, CoinRegistry } from './registry.ts';

/** The Tag's resolved value. One uniform shape across all four
 *  address forms — downstream consumers branch on `source` only if
 *  they care about provenance. */
export interface ResolvedCoin {
	readonly fullCoinType: string;
	readonly decimals: number;
	readonly source: 'registry' | 'on-chain' | 'builtin';
	readonly symbol?: string;
	readonly displayName?: string;
	readonly iconUrl?: string;
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	readonly packageId?: string;
}

// -----------------------------------------------------------------------------
// Builtin SUI
// -----------------------------------------------------------------------------

/** Distilled-doc 13-coin.md Invariant 4: `BUILTIN_COINS.sui` MUST
 *  always be `0x2::sui::SUI` with `decimals: 9`. Protocol-defined; any
 *  divergence breaks downstream guards (Deepbook's SUI guard, the
 *  balance UI's canonical-type compare). */
export const BUILTIN_COINS = {
	sui: {
		fullCoinType: '0x2::sui::SUI',
		decimals: 9,
		source: 'builtin' as const,
		symbol: 'SUI',
		displayName: 'Sui',
	} satisfies ResolvedCoin,
} as const;

export type BuiltinCoinName = keyof typeof BUILTIN_COINS;

/** Resolve a builtin coin. Pure constant — no Effect, no upstream. */
export const resolveBuiltin = (name: BuiltinCoinName): ResolvedCoin => BUILTIN_COINS[name];

// -----------------------------------------------------------------------------
// Form 1: symbol → registry
// -----------------------------------------------------------------------------

/** Project a `CoinRecord` to the resolved-value shape. Shared across
 *  forms 1 + 2. */
const projectRecord = (record: CoinRecord, source: 'registry'): ResolvedCoin => ({
	fullCoinType: record.type,
	decimals: record.decimals,
	source,
	...(record.symbol !== undefined ? { symbol: record.symbol } : {}),
	...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
	...(record.iconUrl !== undefined ? { iconUrl: record.iconUrl } : {}),
	...(record.treasuryCapId !== undefined ? { treasuryCapId: record.treasuryCapId } : {}),
	...(record.metadataId !== undefined ? { metadataId: record.metadataId } : {}),
	packageId: record.packageId,
});

/** Resolve a coin by symbol against the per-stack `CoinRegistry`. */
export const resolveBySymbol = (
	registry: CoinRegistry,
	symbol: string,
): Effect.Effect<ResolvedCoin, CoinError> =>
	Effect.gen(function* () {
		const matches = yield* registry.bySymbol(symbol);
		if (matches.length === 0) {
			const candidates = (yield* registry.list()).map((r) => r.symbol ?? r.witness);
			return yield* Effect.fail(
				coinError('not-found', {
					identifier: symbol,
					message: `coin('${symbol}'): no record matches in the per-stack registry.`,
					candidates,
				}),
			);
		}
		// Distilled-doc 13-coin.md Invariant 5: case-insensitive but
		// exact. Two records pointing at the same coin type are NOT
		// ambiguous (the registry's "register-once-per-key-shape" pattern
		// can index the same coin under both symbol and witness).
		const distinctTypes = new Set(matches.map((m) => m.type));
		if (distinctTypes.size > 1) {
			return yield* Effect.fail(
				coinError('ambiguous', {
					identifier: symbol,
					message: `coin('${symbol}'): matched ${distinctTypes.size} distinct coin types — disambiguate via coin.fromPackage(pkg, witness).`,
					candidates: [...distinctTypes],
				}),
			);
		}
		return projectRecord(matches[0]!, 'registry');
	});

// -----------------------------------------------------------------------------
// Form 2: package-scoped witness → registry
// -----------------------------------------------------------------------------

/** Resolve a coin by `(publishing package's symbolic name, witness)`.
 *  Distilled-doc 13-coin.md §"Lifecycle" path 3: the caller yields
 *  the package tag first to force the dep edge; this helper assumes
 *  the registry is already populated by the time it runs. */
export const resolveByWitness = (
	registry: CoinRegistry,
	packageName: string,
	witness: string,
): Effect.Effect<ResolvedCoin, CoinError> =>
	Effect.gen(function* () {
		const record = yield* registry.byWitness(packageName, witness);
		if (record === null) {
			const candidates = (yield* registry.list())
				.filter((r) => r.publishingPackageName === packageName)
				.map((r) => r.symbol ?? r.witness);
			return yield* Effect.fail(
				coinError('not-found', {
					identifier: `${packageName}::${witness}`,
					message: `coin.fromPackage('${packageName}', '${witness}'): witness not present in the package's discovered coins.`,
					candidates,
				}),
			);
		}
		return projectRecord(record, 'registry');
	});

// -----------------------------------------------------------------------------
// Form 3: bare on-chain type → live RPC
// -----------------------------------------------------------------------------

/** Resolve a coin by bare on-chain type. Calls `getCoinMetadata`
 *  against the resolved Sui client; soft-degrades to `decimals: 0` on
 *  RPC failure (distilled-doc 13-coin.md Failure modes table).
 *
 *  Bare type is validated first (distilled-doc invariant 7: refuses
 *  nested generics). The validator surfaces `CoinError('nested-
 *  generic')`; everything else falls through to the lenient fetch. */
export const resolveByBareType = (
	sdk: MetadataSdkShim,
	fullCoinType: string,
): Effect.Effect<ResolvedCoin, CoinError> =>
	Effect.gen(function* () {
		const validation = validateBareCoinType(fullCoinType);
		if (validation !== null) {
			return yield* Effect.fail(validation);
		}
		if (!isBareCoinType(fullCoinType)) {
			return yield* Effect.fail(
				coinError('not-found', {
					identifier: fullCoinType,
					message: `coin.known('${fullCoinType}'): not a bare on-chain coin type — expected '0xHEX::module::Witness'.`,
				}),
			);
		}
		const metadata = yield* fetchCoinMetadataOnce(sdk, fullCoinType);
		if (metadata === null) {
			// Soft-degradation: surface a record with decimals=0 and no
			// metadata. Downstream consumers that NEED metadata see
			// degraded fields — but we don't fail boot.
			return {
				fullCoinType,
				decimals: 0,
				source: 'on-chain',
			};
		}
		return {
			fullCoinType,
			decimals: metadata.decimals,
			source: 'on-chain',
			symbol: metadata.symbol,
			displayName: metadata.name,
			...(metadata.iconUrl !== undefined ? { iconUrl: metadata.iconUrl } : {}),
			metadataId: metadata.id,
		};
	});
