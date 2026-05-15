// Package(name, path, opts) — publishing a local Move package. Replaces
// the v3 `publishMove({name, path, signer, mvrPlaceholder, capture, coins})`
// factory. Two new conveniences on top of v3:
//
//   - Positional `(name, path)` instead of `{name, path}` — matches
//     how users think about a package ("publish this dir as 'hello'").
//   - `capture` accepts a typed-keys-by-type-substring record in
//     addition to the v3 callback form: `{ treasuryCap: '::coin::TreasuryCap<' }`
//     resolves at acquire time to `treasuryCap: '0x...'`. The callback
//     form is preserved for users who need full programmatic control.

import { publishMove, type CoinSpec, type PublishMoveOptions } from '../primitives/publish-move.js';
import { pickCreatedByTypeIncludes } from '../primitives/sui-helpers.js';
import type { Account, SuiObjectChange } from '../primitives/shared.js';
import type { PluginTag } from '../advanced/tag.js';
import { withSection } from './ref.js';

/** Two accepted shapes for `capture`. */
export type CaptureSpec<TCaptured> =
	/** Declarative form: map of result-key → type-substring. Each entry
	 *  picks the first created object whose type contains the substring.
	 *  Result is a `Record<key, string>` of object ids. */
	| Record<string, string>
	/** Callback form (v3-compatible): receives the full
	 *  `objectChanges` array, returns whatever shape you like. Used when
	 *  the declarative form isn't expressive enough. */
	| ((changes: ReadonlyArray<SuiObjectChange>) => TCaptured);

export interface PackageOptions<
	TCaptured,
	TCoins extends ReadonlyArray<CoinSpec>,
> {
	/** Account that signs the publish transaction and ends up holding
	 *  the resulting `UpgradeCap`. */
	readonly signer: PluginTag<any, Account, any, any>;
	/** Override the MVR placeholder. Defaults to `@local/<slug-of-name>`. */
	readonly mvr?: string;
	/** Object-id capture. See {@link CaptureSpec}. */
	readonly capture?: CaptureSpec<TCaptured>;
	/** Coin specs to register against the published package. */
	readonly coins?: TCoins;
}

/** Compile a `capture` spec down to the v3 callback form `publishMove`
 *  expects. Record form looks up each value via
 *  `pickCreatedByTypeIncludes`; callback form passes through. */
const compileCapture = <TCaptured>(
	spec: CaptureSpec<TCaptured> | undefined,
): ((changes: ReadonlyArray<SuiObjectChange>) => TCaptured) | undefined => {
	if (spec === undefined) return undefined;
	if (typeof spec === 'function') return spec;
	return (changes) => {
		const out: Record<string, string | undefined> = {};
		for (const [k, typeSubstring] of Object.entries(spec)) {
			out[k] = pickCreatedByTypeIncludes(changes, typeSubstring);
		}
		return out as unknown as TCaptured;
	};
};

/** Publishing factory. Returns a Ref carrying the published-package
 *  shape (id, captured, coins). Pass the ref into `Action({ needs: [pkg] })`
 *  or `Bindings({...})` to make the publish a prerequisite. */
export const Package = <
	const N extends string,
	TCaptured = undefined,
	const TCoins extends ReadonlyArray<CoinSpec> = [],
>(
	name: N,
	path: string,
	opts: PackageOptions<TCaptured, TCoins>,
) => {
	const publishOpts: PublishMoveOptions<N, TCaptured, TCoins> = {
		name,
		path,
		signer: opts.signer,
		...(opts.mvr !== undefined ? { mvrPlaceholder: opts.mvr } : {}),
		...(opts.capture !== undefined ? { capture: compileCapture<TCaptured>(opts.capture)! } : {}),
		...(opts.coins !== undefined ? { coins: opts.coins } : {}),
	};
	return withSection(publishMove(publishOpts), 'package');
};
