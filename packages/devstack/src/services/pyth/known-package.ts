// `pythKnownPackage(opts)` — point `PythTag` at the canonical Pyth
// deployment for a known network. Sources packageId + pythStateId +
// wormholeStateId + the per-feed PriceInfoObject ids from
// `knownDeployments.deepbook.<network>.pyth` and per-coin entries.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import { provide } from '../../advanced/tag.js';
import { knownDeployments, type KnownNetwork } from '../../engine/known-deployments.js';
import { publishPythState } from '../../engine/registries.js';
import { PythTag, type PythPriceInfo, type Pyth } from './tag.js';
import type { PythPriceFeedId } from './internal.js';

export interface PythKnownPackageOptions {
	/** Sui network whose Pyth deployment to read from. */
	readonly network: KnownNetwork;
	/** Override packageId. Useful for pinning to a private fork. */
	readonly packageId?: string;
	/** Override pyth state id. */
	readonly pythStateId?: string;
	/** Override wormhole state id. */
	readonly wormholeStateId?: string;
	/** Explicit per-feed PriceInfoObject ids. When unset, derived from
	 *  `knownDeployments.deepbook.<network>.coins[].priceInfoObjectId`. */
	readonly priceInfoObjects?: ReadonlyArray<{
		readonly label: string;
		readonly feedId: PythPriceFeedId;
		readonly priceInfoObjectId: string;
	}>;
}

export const pythKnownPackage = (opts: PythKnownPackageOptions) => {
	const dbk = knownDeployments.deepbook[opts.network];
	const pythStateId = opts.pythStateId ?? dbk?.pyth?.pythStateId;
	const wormholeStateId = opts.wormholeStateId ?? dbk?.pyth?.wormholeStateId;

	// Without a packageId we don't have a Pyth deployment to wrap. The
	// known deployment carries deepbook info but the Pyth package id is
	// not exported separately; callers can supply it via `opts.packageId`.
	// Falls back to the empty string so the typed accessors don't break,
	// but the call site should always pass `packageId` explicitly for
	// testnet/mainnet today.
	const packageId = opts.packageId ?? '';

	const explicit = opts.priceInfoObjects ?? [];
	const derived: ReadonlyArray<PythPriceInfo> =
		explicit.length > 0
			? explicit
			: Object.entries(dbk?.coins ?? {}).flatMap(([label, c]): ReadonlyArray<PythPriceInfo> => {
					const feed = (c as { feed?: unknown }).feed;
					const priceInfoObjectId = (c as { priceInfoObjectId?: unknown }).priceInfoObjectId;
					if (typeof feed !== 'string' || typeof priceInfoObjectId !== 'string') return [];
					return [{ label, feedId: feed, priceInfoObjectId }];
				});

	return provide(
		PythTag,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'pyth.packageId': packageId,
				'pyth.feedCount': derived.length,
			});
			yield* publishPythState({
				name: `pyth.${opts.network}`,
				packageId,
				...(pythStateId !== undefined ? { pythStateId } : {}),
				...(wormholeStateId !== undefined ? { wormholeStateId } : {}),
				priceInfoObjectIds: Object.fromEntries(derived.map((p) => [p.feedId, p.priceInfoObjectId])),
				feeds: Object.fromEntries(derived.map((p) => [p.label, p.feedId])),
			});
			return {
				packageId,
				pythStateId,
				wormholeStateId,
				priceInfos: derived,
				findPriceInfo: (feed) => derived.find((p) => p.feedId === feed),
				findPriceInfoByLabel: (label) => derived.find((p) => p.label === label),
			} satisfies Pyth;
		}).pipe(Effect.withSpan('pythKnownPackage')),
		{
			kind: 'service',
			plugin: 'pyth',
			displayTitle: 'pyth.known',
			display: (s) => ({ title: 'pyth.known', primary: s.packageId }),
		},
	);
};
