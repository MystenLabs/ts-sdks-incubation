// Pyth — internal module under the DeepBook plugin.
//
// Local mode uses the DeepBook sandbox's mock Pyth package shape: publish a
// local Move package with `pyth::create_price_feeds`, then create shared
// `PriceInfoObject`s for the requested feeds. This is intentionally not a
// top-level devstack plugin; DeepBook owns the oracle wiring it needs.

import { Effect, type Scope } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, fromHex, toHex } from '@mysten/sui/utils';

import {
	artifactPublishError,
	type ArtifactPublisher,
} from '../../../primitives/artifact-publisher.ts';
import { acquireOnChainArtifact } from '../../internal/acquire-on-chain-artifact.ts';
import type { ResolvedSigner } from '../../../substrate/runtime/sui-execute/index.ts';
import {
	executeSuiTx,
	formatExecutedFailure,
} from '../../../substrate/runtime/sui-execute/index.ts';
import { probeManyLenient } from '../../../substrate/runtime/probes.ts';
import { chainId as brandChainId } from '../../../substrate/brand.ts';
import type { SuiSdkShim } from '../../sui/index.ts';
import { deepbookPluginError, type DeepbookPluginError } from '../errors.ts';
import { stableContentHash } from '../hash.ts';
import { DeepbookSpans } from '../spans.ts';
import type { PythFeed, PythHandle, PythPriceFeedId } from '../types.ts';

export interface PythDeployment {
	readonly packageId: string;
}

interface CachedPythFeed {
	readonly symbol: string;
	readonly feedId: string;
	readonly priceInfoObjectId: string;
	readonly price: string;
	readonly expo: number;
}

interface CachedPythHandle {
	readonly packageId: string;
	readonly feeds: ReadonlyArray<CachedPythFeed>;
}

const DEFAULT_EXPO = -8;
const PYTH_GAS_BUDGET = 200_000_000;

const normalizeFeedId = (feedId: string): string => feedId.replace(/^0x/i, '').toLowerCase();

const feedExpo = (feed: PythFeed): number => feed.expo ?? DEFAULT_EXPO;

const toCachedFeed = (feed: PythFeed, priceInfoObjectId: string): CachedPythFeed => ({
	symbol: feed.symbol,
	feedId: normalizeFeedId(feed.feedId),
	priceInfoObjectId,
	price: feed.initialPrice.toString(),
	expo: feedExpo(feed),
});

const fromCachedHandle = (cached: CachedPythHandle): PythHandle => ({
	packageId: cached.packageId,
	stateId: null,
	wormholeStateId: null,
	feeds: cached.feeds.map((feed) => ({
		symbol: feed.symbol,
		feedId: normalizeFeedId(feed.feedId) as PythPriceFeedId,
		priceInfoObjectId: feed.priceInfoObjectId,
		price: BigInt(feed.price),
		expo: feed.expo,
	})),
});

const pythInputsHash = (
	pkg: PythDeployment,
	signer: ResolvedSigner,
	feeds: ReadonlyArray<PythFeed>,
) =>
	stableContentHash(
		[
			'v1',
			pkg.packageId,
			signer.address,
			...feeds
				.map((feed) =>
					[
						feed.symbol,
						normalizeFeedId(feed.feedId),
						feed.initialPrice.toString(),
						feedExpo(feed).toString(),
						(feed.confidence ?? 0n).toString(),
						(feed.emaPrice ?? feed.initialPrice).toString(),
					].join('|'),
				)
				.sort(),
		].join('||'),
	);

const buildVerifyProbe = (
	sdk: SuiSdkShim,
	cached: CachedPythHandle,
): Effect.Effect<CachedPythHandle | null, never> =>
	Effect.gen(function* () {
		const results = yield* probeManyLenient(
			cached.feeds.map((feed) =>
				Effect.tryPromise({
					try: () => sdk.core.getObject({ objectId: feed.priceInfoObjectId }),
					catch: () => null,
				}).pipe(Effect.catch(() => Effect.succeed(null))),
			),
		);
		if (results.some((raw) => raw === null || raw === undefined)) return null;
		return cached;
	});

const addI64 = (tx: Transaction, packageId: string, value: bigint | number) => {
	const raw = BigInt(value);
	const negative = raw < 0n;
	return tx.moveCall({
		target: `${packageId}::i64::new`,
		arguments: [tx.pure.u64(negative ? -raw : raw), tx.pure.bool(negative)],
	});
};

const addPriceInfo = (tx: Transaction, packageId: string, feed: PythFeed, timestamp: bigint) => {
	const price = tx.moveCall({
		target: `${packageId}::price::new`,
		arguments: [
			addI64(tx, packageId, feed.initialPrice),
			tx.pure.u64(feed.confidence ?? 0n),
			addI64(tx, packageId, BigInt(feedExpo(feed))),
			tx.pure.u64(timestamp),
		],
	});
	const emaPrice = tx.moveCall({
		target: `${packageId}::price::new`,
		arguments: [
			addI64(tx, packageId, feed.emaPrice ?? feed.initialPrice),
			tx.pure.u64(feed.confidence ?? 0n),
			addI64(tx, packageId, BigInt(feedExpo(feed))),
			tx.pure.u64(timestamp),
		],
	});
	const priceIdentifier = tx.moveCall({
		target: `${packageId}::price_identifier::from_byte_vec`,
		arguments: [tx.pure.vector('u8', Array.from(fromHex(normalizeFeedId(feed.feedId))))],
	});
	const priceFeed = tx.moveCall({
		target: `${packageId}::price_feed::new`,
		arguments: [priceIdentifier, price, emaPrice],
	});
	return tx.moveCall({
		target: `${packageId}::price_info::new_price_info`,
		arguments: [tx.pure.u64(timestamp), tx.pure.u64(timestamp), priceFeed],
	});
};

const feedIdBytesFromJson = (bytes: unknown): Uint8Array | null => {
	if (typeof bytes === 'string' && bytes.length > 0) {
		try {
			return fromBase64(bytes);
		} catch {
			return null;
		}
	}
	if (!Array.isArray(bytes) || bytes.length === 0) return null;
	if (!bytes.every((byte): byte is number => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
		return null;
	}
	return Uint8Array.from(bytes);
};

export const feedIdFromJson = (json: unknown): string | null => {
	if (typeof json !== 'object' || json === null) return null;
	const priceInfo = (json as { readonly price_info?: unknown }).price_info;
	if (typeof priceInfo !== 'object' || priceInfo === null) return null;
	const priceFeed = (priceInfo as { readonly price_feed?: unknown }).price_feed;
	if (typeof priceFeed !== 'object' || priceFeed === null) return null;
	const priceIdentifier = (priceFeed as { readonly price_identifier?: unknown }).price_identifier;
	if (typeof priceIdentifier !== 'object' || priceIdentifier === null) return null;
	const bytes = (priceIdentifier as { readonly bytes?: unknown }).bytes;
	const decoded = feedIdBytesFromJson(bytes);
	if (decoded === null) return null;
	return normalizeFeedId(toHex(decoded));
};

const mapCreatedPriceObjects = async (
	sdk: SuiSdkShim,
	objectIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> => {
	const objects = await sdk.client.core.getObjects({
		objectIds: [...objectIds],
		include: { json: true },
	});
	const result = new Map<string, string>();
	for (const object of objects.objects) {
		if (object instanceof Error) continue;
		const feedId = feedIdFromJson(object.json);
		if (feedId !== null) result.set(feedId, object.objectId);
	}
	return result;
};

const pickCreatedPriceInfoObjects = (
	changes: ReadonlyArray<{
		readonly objectId: string;
		readonly objectType?: string;
		readonly idOperation?: string;
	}>,
): ReadonlyArray<string> =>
	changes
		.filter(
			(change) =>
				change.idOperation === 'Created' &&
				change.objectType?.includes('::price_info::PriceInfoObject') === true,
		)
		.map((change) => change.objectId);

/** Create shared mock-Pyth PriceInfoObjects for local DeepBook feeds. */
export const initLocalPythFeeds = (
	publisher: ArtifactPublisher,
	sdk: SuiSdkShim,
	chain: string,
	signer: ResolvedSigner,
	pkg: PythDeployment,
	feeds: ReadonlyArray<PythFeed>,
): Effect.Effect<PythHandle | null, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		if (feeds.length === 0) return null;

		const cached = yield* acquireOnChainArtifact<CachedPythHandle, CachedPythHandle>(publisher, {
			namespace: 'deepbook/pyth',
			chain: brandChainId(chain),
			contentHash: pythInputsHash(pkg, signer, feeds),
			verify: (entry) => buildVerifyProbe(sdk, entry),
			produce: Effect.gen(function* () {
				const result = yield* executeSuiTx({
					client: sdk.client,
					signer,
					build: async () => {
						const tx = new Transaction();
						tx.setSender(signer.address);
						tx.setGasBudget(PYTH_GAS_BUDGET);
						const timestamp = 0n;
						const priceInfos = feeds.map((feed) =>
							addPriceInfo(tx, pkg.packageId, feed, timestamp),
						);
						tx.moveCall({
							target: `${pkg.packageId}::pyth::create_price_feeds`,
							arguments: [
								tx.makeMoveVec({
									type: `${pkg.packageId}::price_info::PriceInfo`,
									elements: priceInfos,
								}),
							],
						});
						return tx.build({ client: sdk.client });
					},
				}).pipe(
					Effect.mapError((err) =>
						artifactPublishError(
							'produce-failed',
							`pyth feed transaction failed: ${err.message}`,
						),
					),
				);
				if (result.$kind === 'FailedTransaction') {
					return yield* Effect.fail(
						artifactPublishError(
							'produce-failed',
							`pyth feed transaction on-chain execution failed ` +
								formatExecutedFailure(result.FailedTransaction),
						),
					);
				}
				const receipt = result.Transaction;

				const created = pickCreatedPriceInfoObjects(receipt.objectChanges);
				if (created.length !== feeds.length) {
					return yield* Effect.fail(
						artifactPublishError(
							'produce-failed',
							`expected ${feeds.length} Pyth PriceInfoObject creations, got ${created.length} ` +
								`(digest=${receipt.digest}).`,
						),
					);
				}
				const idsByFeed = yield* Effect.tryPromise({
					try: () => mapCreatedPriceObjects(sdk, created),
					catch: (cause) =>
						artifactPublishError(
							'produce-failed',
							`failed to read created Pyth PriceInfoObjects: ${
								cause instanceof Error ? cause.message : String(cause)
							}`,
						),
				});
				const cachedFeeds: CachedPythFeed[] = [];
				for (const feed of feeds) {
					const priceInfoObjectId = idsByFeed.get(normalizeFeedId(feed.feedId));
					if (priceInfoObjectId === undefined) {
						return yield* Effect.fail(
							artifactPublishError(
								'produce-failed',
								`created Pyth PriceInfoObject for '${feed.symbol}' was not found by feed id.`,
							),
						);
					}
					cachedFeeds.push(toCachedFeed(feed, priceInfoObjectId));
				}
				return { packageId: pkg.packageId, feeds: cachedFeeds };
			}),
		}).pipe(
			Effect.mapError(
				(err): DeepbookPluginError =>
					deepbookPluginError(
						'pyth-feed',
						err._tag === 'ArtifactPublishError' ? err.detail : String(err),
					),
			),
		);

		return fromCachedHandle(cached);
	}).pipe(
		Effect.withSpan('devstack.plugin.deepbook.pyth.initFeeds', {
			attributes: {
				[DeepbookSpans.pyth.packageId]: pkg.packageId,
				[DeepbookSpans.pyth.feedCount]: feeds.length,
			},
		}),
	);

// Compatibility exports for callers/tests that import the internal module.
export type { PythFeed, PythHandle, PythOptions } from '../types.ts';
export {
	DEEP_PRICE_FEED_ID,
	pythPriceFeedId,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from '../types.ts';
