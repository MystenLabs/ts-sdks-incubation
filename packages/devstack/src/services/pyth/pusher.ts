// `PythPusher(opts)` — long-running fiber that fetches historical-24h
// prices from the Pyth Benchmarks API and calls
// `pyth::update_single_price_feed` on each tick. Mirrors the
// deepbook-sandbox oracle-service container, run as an in-process
// Effect fiber per D2.
//
// Schedule: `Schedule.spaced(refreshMs)` (default 10s). First tick fires
// synchronously inside the producer so a configuration error (bad feed
// id, unreachable API) surfaces as a startup failure rather than a
// silent loop. The pusher signer must differ from any maker's signer
// (R8) — gas-coin contention would otherwise drop updates.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Option, Schedule } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { StateStore } from '../../engine/state-store.js';
import { StateStoreKeys } from '../../engine/state-store-keys.js';
import { PythError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import {
	DEFAULT_PYTH_API_URL,
	DEFAULT_HISTORICAL_HOURS,
	DEFAULT_PUSHER_REFRESH_MS,
	hexToBytes,
	type PythPriceFeedId,
} from './internal.js';

// State-store key prefix for pyth-pusher moved to
// `engine/state-store-keys.ts`. Canonical builder:
// `StateStoreKeys.pythPusher({chainId, packageId, signerAddress})`.
const STATE_KEY_PUSHER_PREFIX = 'pyth/pusher/v1';

interface CachedPusher {
	readonly lastDigest: string;
	readonly lastUpdatedMs: number;
}

export interface PythPusherHandle {
	readonly pid: number;
}

export type PythPusherSource =
	| {
			readonly kind: 'benchmarks';
			readonly url?: string;
			readonly historicalHours?: number;
	  }
	| {
			readonly kind: 'fixture';
			readonly fetch: (
				feedIds: ReadonlyArray<PythPriceFeedId>,
			) => Effect.Effect<ReadonlyArray<PythPriceUpdate>, unknown, unknown>;
	  };

/** Raw Pyth price update payload. The pusher converts these into
 *  `update_single_price_feed` move calls. */
export interface PythPriceUpdate {
	readonly feedId: PythPriceFeedId;
	readonly priceMagnitude: bigint;
	readonly priceNegative: boolean;
	readonly expoMagnitude: bigint;
	readonly expoNegative: boolean;
	readonly publishTime: bigint;
	readonly emaPriceMagnitude?: bigint;
	readonly emaPriceNegative?: boolean;
	readonly conf?: bigint;
	readonly emaConf?: bigint;
}

export interface PythPusherOptions<Name extends string> {
	readonly name: Name;
	/** Account that signs the update tx. **Must differ from any
	 *  maker's signer** (R8). Convention-enforced — no runtime check. */
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Pyth tag (the on-chain `PriceInfoObject`s to update). */
	readonly pyth: LayeredTag<any, import('./tag.js').Pyth, any, any>;
	/** Refresh cadence in ms. Default 10_000. */
	readonly refreshMs?: number;
	/** Where to source price updates. Default `{ kind: 'benchmarks' }`. */
	readonly source?: PythPusherSource;
	/** Gas budget per update tx. Default 200_000_000n (sandbox parity). */
	readonly gasBudget?: bigint;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

const fetchBenchmarks = (
	baseUrl: string,
	historicalHours: number,
	feedIds: ReadonlyArray<PythPriceFeedId>,
): Effect.Effect<ReadonlyArray<PythPriceUpdate>, PythError> =>
	Effect.gen(function* () {
		const timestamp = Math.floor(Date.now() / 1000) - historicalHours * 3600;
		const url = new URL(`${baseUrl}/v1/updates/price/${timestamp}`);
		for (const id of feedIds) {
			const stripped = id.startsWith('0x') ? id.slice(2) : id;
			url.searchParams.append('ids[]', stripped);
		}
		url.searchParams.set('encoding', 'hex');
		url.searchParams.set('parsed', 'true');

		const res = yield* Effect.tryPromise({
			try: async () => {
				const r = await fetch(url.toString(), {
					signal: AbortSignal.timeout(15_000),
				});
				if (!r.ok) {
					throw new Error(`Pyth benchmarks API returned ${r.status}: ${await r.text()}`);
				}
				return (await r.json()) as { readonly parsed?: ReadonlyArray<ParsedPrice> };
			},
			catch: (cause) =>
				new PythError({
					phase: 'pusher-fetch',
					message: `pyth pusher: benchmarks fetch failed for ${feedIds.length} feeds`,
					cause,
				}),
		});

		const parsed = res.parsed ?? [];
		return parsed.map((p) => {
			const priceMag = BigInt(p.price.price);
			const expoNum = Number(p.price.expo);
			return {
				feedId: '0x' + p.id,
				priceMagnitude: priceMag < 0n ? -priceMag : priceMag,
				priceNegative: priceMag < 0n,
				expoMagnitude: BigInt(Math.abs(expoNum)),
				expoNegative: expoNum < 0,
				publishTime: BigInt(p.price.publish_time),
				emaPriceMagnitude: BigInt(p.ema_price.price.replace('-', '')),
				emaPriceNegative: p.ema_price.price.startsWith('-'),
				conf: BigInt(p.price.conf),
				emaConf: BigInt(p.ema_price.conf),
			} satisfies PythPriceUpdate;
		});
	});

interface ParsedPrice {
	readonly id: string;
	readonly price: {
		readonly price: string;
		readonly expo: number;
		readonly publish_time: number;
		readonly conf: string;
	};
	readonly ema_price: {
		readonly price: string;
		readonly expo: number;
		readonly publish_time: number;
		readonly conf: string;
	};
}

export const PythPusher = <const Name extends string>(opts: PythPusherOptions<Name>) =>
	tag(
		opts.name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}
			const sui = yield* SuiTag;
			const signer = yield* opts.signer;
			const pyth = yield* opts.pyth;
			const state = yield* StateStore;

			const refreshMs = opts.refreshMs ?? DEFAULT_PUSHER_REFRESH_MS;
			const source: PythPusherSource = opts.source ?? { kind: 'benchmarks' };
			const gasBudget = opts.gasBudget ?? 200_000_000n;
			const cacheKey = StateStoreKeys.pythPusher({
				chainId: sui.chainId,
				packageId: pyth.packageId,
				signerAddress: signer.address,
			});

			const cached = yield* state.get<CachedPusher>(cacheKey);
			if (Option.isSome(cached)) {
				yield* Effect.annotateCurrentSpan({
					'pyth.pusher.cache': 'hit',
					'pyth.pusher.lastDigest': cached.value.lastDigest,
				});
			}

			const fetchUpdates = (
				feedIds: ReadonlyArray<PythPriceFeedId>,
			): Effect.Effect<ReadonlyArray<PythPriceUpdate>, PythError> => {
				if (source.kind === 'benchmarks') {
					const baseUrl = source.url ?? DEFAULT_PYTH_API_URL;
					const historicalHours = source.historicalHours ?? DEFAULT_HISTORICAL_HOURS;
					return fetchBenchmarks(baseUrl, historicalHours, feedIds);
				}
				// fixture
				return source.fetch(feedIds).pipe(
					Effect.mapError(
						(cause) =>
							new PythError({
								phase: 'pusher-fetch',
								message: `pyth pusher: fixture source failed`,
								cause: cause as unknown as Error,
							}),
					),
				) as Effect.Effect<ReadonlyArray<PythPriceUpdate>, PythError>;
			};

			if (pyth.priceInfos.length === 0) {
				return yield* Effect.fail(
					new PythError({
						phase: 'pyth',
						message: `PythPusher(${opts.name}): no PriceInfoObjects to update`,
					}),
				);
			}

			const tickOnce = Effect.gen(function* () {
				const feedIds = pyth.priceInfos.map((p) => p.feedId);
				const updates = yield* fetchUpdates(feedIds);

				if (updates.length === 0) {
					yield* Effect.logWarning(
						`PythPusher(${opts.name}): no updates returned for ${feedIds.length} feeds`,
					);
					return;
				}

				const t = new Transaction();
				t.setGasBudget(gasBudget);

				for (const update of updates) {
					const priceInfo = pyth.findPriceInfo(update.feedId);
					if (priceInfo === undefined) {
						yield* Effect.logWarning(
							`PythPusher(${opts.name}): no PriceInfoObject for feed ${update.feedId}`,
						);
						continue;
					}
					t.moveCall({
						target: `${pyth.packageId}::pyth::update_single_price_feed`,
						typeArguments: [],
						arguments: [
							t.object(pyth.pythStateId ?? '0x0'),
							t.object(priceInfo.priceInfoObjectId),
							t.pure.u64(update.priceMagnitude),
							t.pure.bool(update.priceNegative),
							t.pure.u64(update.expoMagnitude),
							t.pure.bool(update.expoNegative),
							t.pure.u64(update.emaPriceMagnitude ?? update.priceMagnitude),
							t.pure.bool(update.emaPriceNegative ?? update.priceNegative),
							t.pure.u64(update.conf ?? 0n),
							t.pure.u64(update.emaConf ?? update.conf ?? 0n),
							t.pure.u64(update.publishTime),
							t.pure.vector('u8', hexToBytes(update.feedId)),
							t.object('0x6'),
						],
					});
				}

				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PythError({
								phase: 'pusher-update',
								message: `PythPusher(${opts.name}): update tx failed: ${cause.message}`,
								cause,
							}),
					),
				);

				yield* state
					.put(cacheKey, {
						lastDigest: result.digest,
						lastUpdatedMs: Date.now(),
					} satisfies CachedPusher)
					.pipe(Effect.ignore);
			}).pipe(Effect.withSpan('PythPusher.tick'));

			// Forgive transient failures — schedule keeps ticking.
			const loopOnce = tickOnce.pipe(
				Effect.catch((cause: unknown) =>
					Effect.logWarning(`PythPusher(${opts.name}): tick failed: ${stringifyCause(cause)}`),
				),
			);

			// First tick synchronously so configuration errors surface at boot.
			yield* tickOnce.pipe(
				Effect.mapError(
					(cause) =>
						new PythError({
							phase: 'pusher-update',
							message: `PythPusher(${opts.name}): initial tick failed: ${cause.message}`,
							cause,
						}),
				),
			);

			yield* Effect.forkScoped(loopOnce.pipe(Effect.repeat(Schedule.spaced(refreshMs))));

			return { pid: 0 } satisfies PythPusherHandle;
		}).pipe(
			Effect.withSpan(`PythPusher(${opts.name})`),
			Effect.catchTag('PythError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new PythError({
						phase: 'pyth',
						message: `PythPusher(${opts.name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'service',
			plugin: 'pyth',
			displayTitle: `pyth.pusher.${opts.name}`,
			display: () => ({
				title: `pyth.pusher.${opts.name}`,
				primary: `${opts.refreshMs ?? DEFAULT_PUSHER_REFRESH_MS}ms`,
			}),
		},
	);

export const STATE_KEY_PUSHER_PREFIX_INTERNAL = STATE_KEY_PUSHER_PREFIX;
