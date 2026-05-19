// `PythTag` — Context.Service tag for downstream consumers of any
// Pyth-producing factory (local-deploy or known-package). Read-side
// view exposes the package id, optional state ids, and a per-feed
// lookup so callers can resolve a `PriceInfoObject` by feed id or by
// the friendly label set in the deploy options.

import { Context } from 'effect';
import type { PythPriceFeedId } from './internal.js';

/** One resolved Pyth feed: the immutable `feedId` (mainnet hex),
 *  the on-chain `PriceInfoObject` id, and the friendly label set at
 *  deploy time. */
export interface PythPriceInfo {
	readonly label: string;
	readonly feedId: PythPriceFeedId;
	readonly priceInfoObjectId: string;
}

/** Fields every Pyth-producing factory must surface. */
export interface Pyth {
	readonly packageId: string;
	readonly pythStateId: string | undefined;
	readonly wormholeStateId: string | undefined;
	readonly priceInfos: ReadonlyArray<PythPriceInfo>;
	readonly findPriceInfo: (feed: PythPriceFeedId) => PythPriceInfo | undefined;
	readonly findPriceInfoByLabel: (label: string) => PythPriceInfo | undefined;
}

export class PythTag extends Context.Service<PythTag, Pyth>()('@devstack/PythTag') {}
