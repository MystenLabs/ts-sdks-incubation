// `pythMid({pyth, feed, scale, quote?, refreshMs?, initial?})` — a Ref
// helper that polls a Pyth `PriceInfoObject`'s on-chain price + EMA and
// returns a `.read()` callable shape compatible with
// `DeepbookMarketMakerPoolSpec.midPrice` (`bigint | () => bigint`).
//
// Cross-rate support: when `quote` is set, the read returns
// `base_price / quote_price` after scaling. The function consumes Pyth's
// `(priceMagnitude, expoMagnitude)` shape and scales to the caller's
// chosen `bigint` domain.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Ref, Schedule } from 'effect';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { PythError } from '../../engine/errors.js';
import { type Pyth } from './tag.js';
import type { PythPriceFeedId } from './shared.js';

export interface PythMidScale {
	/** Number of decimal places the resulting price should carry. */
	readonly priceDecimals: number;
	/** Number of decimal places the underlying base coin uses. */
	readonly baseDecimals?: number;
	/** Number of decimal places the underlying quote coin uses (only
	 *  used when `quote` is set). */
	readonly quoteDecimals?: number;
}

export interface PythMidOptions<Name extends string> {
	readonly name?: Name;
	/** Pyth Ref (the on-chain `PriceInfoObject` lookups). */
	readonly pyth: LayeredTag<any, Pyth, any, any>;
	/** Base feed id (mainnet hex). */
	readonly feed: PythPriceFeedId;
	/** Optional quote feed id — when present, the read returns
	 *  `base / quote`. Useful for SUI/USDC where both feeds are dollar-
	 *  denominated. */
	readonly quote?: PythPriceFeedId;
	/** Output scaling. */
	readonly scale: PythMidScale;
	/** Refresh cadence in ms. Default 5_000. */
	readonly refreshMs?: number;
	/** Initial price to return until the first poll completes. Required
	 *  per OD5 — no auto-poll fallback. */
	readonly initial: bigint;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

export interface PythMid {
	readonly read: () => bigint;
	readonly readEffect: Effect.Effect<bigint, never>;
}

// Apply (priceMagnitude, expoMagnitude) → bigint at the requested
// number of decimal places. Pyth typically returns expo = -8, so a
// raw price like `350_000_000` with expo `-8` equals 3.50 dollars.
// We rescale to `10^priceDecimals` for the bigint domain the maker
// expects (e.g. priceDecimals=6 ⇒ 3_500_000 for 3.50).
const rescalePythPrice = (
	priceMag: bigint,
	priceNegative: boolean,
	expoMag: bigint,
	expoNegative: boolean,
	targetDecimals: number,
): bigint => {
	if (priceNegative) return 0n;
	const expoInt = Number(expoMag) * (expoNegative ? -1 : 1);
	// `priceMag * 10^(targetDecimals + expoInt)`. When the resulting
	// shift is negative, divide; positive, multiply.
	const shift = targetDecimals + expoInt;
	if (shift >= 0) {
		return priceMag * 10n ** BigInt(shift);
	}
	return priceMag / 10n ** BigInt(-shift);
};

export const pythMid = <const Name extends string = 'pythMid'>(opts: PythMidOptions<Name>) => {
	const name = (opts.name ?? 'pythMid') as Name;
	const refreshMs = opts.refreshMs ?? 5_000;

	return tag(
		name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}
			const sui = yield* SuiTag;
			const pyth = yield* opts.pyth;

			const ref = yield* Ref.make<bigint>(opts.initial);

			const baseInfo = pyth.findPriceInfo(opts.feed);
			if (baseInfo === undefined) {
				return yield* Effect.fail(
					new PythError({
						phase: 'pyth',
						feed: opts.feed,
						message: `pythMid(${name}): base feed ${opts.feed} not registered with Pyth`,
					}),
				);
			}
			const quoteInfo = opts.quote !== undefined ? pyth.findPriceInfo(opts.quote) : undefined;
			if (opts.quote !== undefined && quoteInfo === undefined) {
				return yield* Effect.fail(
					new PythError({
						phase: 'pyth',
						feed: opts.quote,
						message: `pythMid(${name}): quote feed ${opts.quote} not registered with Pyth`,
					}),
				);
			}

			const readObjectPrice = (
				objectId: string,
			): Effect.Effect<
				{
					readonly priceMag: bigint;
					readonly priceNeg: boolean;
					readonly expoMag: bigint;
					readonly expoNeg: boolean;
				},
				PythError
			> =>
				Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId }),
					catch: (cause) =>
						new PythError({
							phase: 'pyth',
							feed: opts.feed,
							message: `pythMid(${name}): getObject failed for ${objectId}`,
							cause: cause as Error,
						}),
				}).pipe(
					Effect.flatMap((res) => {
						// The on-chain `PriceInfoObject` carries a `price_feed`
						// field with `price.price` (i64) + `price.expo` (i32).
						// Effect's gRPC client returns the parsed content as
						// `content.fields`. Walk the structure defensively —
						// the field names are stable in the Move source.
						const parsed = (res as { content?: { fields?: any } }).content?.fields;
						const priceFeed = parsed?.price_info?.fields?.price_feed?.fields;
						const price = priceFeed?.price?.fields;
						if (price === undefined) {
							return Effect.fail(
								new PythError({
									phase: 'pyth',
									feed: opts.feed,
									message: `pythMid(${name}): unable to parse PriceInfoObject content`,
								}),
							);
						}
						return Effect.succeed({
							priceMag: BigInt(price.price?.fields?.magnitude ?? '0'),
							priceNeg: Boolean(price.price?.fields?.negative ?? false),
							expoMag: BigInt(price.expo?.fields?.magnitude ?? '0'),
							expoNeg: Boolean(price.expo?.fields?.negative ?? false),
						});
					}),
				);

			const tickOnce = Effect.gen(function* () {
				const basePrice = yield* readObjectPrice(baseInfo.priceInfoObjectId);
				const baseScaled = rescalePythPrice(
					basePrice.priceMag,
					basePrice.priceNeg,
					basePrice.expoMag,
					basePrice.expoNeg,
					opts.scale.priceDecimals,
				);

				let result = baseScaled;
				if (quoteInfo !== undefined) {
					const quotePrice = yield* readObjectPrice(quoteInfo.priceInfoObjectId);
					const quoteScaled = rescalePythPrice(
						quotePrice.priceMag,
						quotePrice.priceNeg,
						quotePrice.expoMag,
						quotePrice.expoNeg,
						opts.scale.priceDecimals,
					);
					if (quoteScaled > 0n) {
						// base / quote, preserve `priceDecimals` decimals after
						// the division.
						result = (baseScaled * 10n ** BigInt(opts.scale.priceDecimals)) / quoteScaled;
					}
				}

				if (result > 0n) {
					yield* Ref.set(ref, result);
				}
			}).pipe(
				Effect.catch((cause: unknown) =>
					Effect.logWarning(`pythMid(${name}): tick failed: ${stringifyCause(cause)}`),
				),
			);

			// First tick is best-effort: if the on-chain read fails (e.g.
			// the pusher hasn't published yet), keep the caller-supplied
			// `initial` value and retry on the next schedule.
			yield* tickOnce;
			yield* Effect.forkScoped(tickOnce.pipe(Effect.repeat(Schedule.spaced(refreshMs))));

			const read = (): bigint => {
				return Effect.runSync(Ref.get(ref));
			};
			const readEffect = Ref.get(ref);
			return { read, readEffect } satisfies PythMid;
		}).pipe(Effect.withSpan(`PythMid(${name})`)),
		{
			kind: 'service',
			plugin: 'pyth',
			displayTitle: `pyth.mid.${name}`,
			display: (s: PythMid) => ({
				title: `pyth.mid.${name}`,
				primary: s.read().toString(),
			}),
		},
	);
};
