// Coin plugin — typed errors.
//
// Coin-side failures unify into a SINGLE tagged error with a CLOSED
// phase set so downstream `catchTag` callers can distinguish "not in
// registry" from "mint failed" from "cap missing".
//
// Effect v4: plain interface + `_tag` literal discriminator (no
// subclassing). Mirrors the Account plugin's split shape and the
// substrate's per-plugin tagged-error convention.

/** Phases for `CoinError`. Closed sum — adding a phase requires
 *  editing this list AND the cause walker's display table.
 *
 *  Phase semantics:
 *   - `not-found`           — symbol/witness/bare-type didn't resolve
 *                             against the registry / on-chain metadata.
 *   - `ambiguous`           — two distinct coin types matched a single
 *                             registry-key lookup. Caller should
 *                             disambiguate via the witness form.
 *   - `nested-generic`      — bare-coin-type rejected because it
 *                             carried a nested generic (`<T<U>>`).
 *                             Distilled-doc invariant 7: refuse to
 *                             guess. Surfaces during the discovery
 *                             walker AND during the address-resolution
 *                             bare-string branch.
 *   - `cap-missing`         — the package didn't capture a
 *                             `TreasuryCap` under the requested field
 *                             (either no cap at all, or the captured
 *                             record key is wrong).
 *   - `metadata-fetch`      — `getCoinMetadata` failed after retries.
 *                             Soft-degradation path: the discovery
 *                             walker swallows this to keep partial
 *                             coverage; the bare-coin-type branch of
 *                             the user-facing factory surfaces it.
 *   - `mint-tx`             — sign-and-execute of the mint tx failed.
 *   - `mint-parse`          — the minted `Coin<T>` was not present in
 *                             the resulting `objectChanges`. */
export type CoinPhase =
	| 'not-found'
	| 'ambiguous'
	| 'nested-generic'
	| 'cap-missing'
	| 'metadata-fetch'
	| 'mint-tx'
	| 'mint-parse';

/** Single tagged coin error. */
export interface CoinError {
	readonly _tag: 'CoinError';
	readonly phase: CoinPhase;
	/** User-facing identifier — the symbol / witness / bare-type the
	 *  caller passed. Populated even when the cause was a mint
	 *  (in which case it carries the resolved fullCoinType so the
	 *  pretty-cause walker can render context). */
	readonly identifier: string;
	readonly message: string;
	/** Optional list of registered candidates — populated by
	 *  `not-found` / `ambiguous` so the renderer can show what WAS
	 *  available. */
	readonly candidates?: ReadonlyArray<string>;
	readonly cause?: unknown;
}

export const coinError = (
	phase: CoinPhase,
	parts: Omit<CoinError, '_tag' | 'phase'>,
): CoinError => ({ _tag: 'CoinError', phase, ...parts });

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const COIN_ERROR_TAGS = ['CoinError'] as const;
