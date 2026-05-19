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
//
// Migrated to the canonical cache substrate per `notes/integration-
// contract-redesign.md`. Each PriceInfoObject's push has its own cache
// entry under the bare `pyth/pusher` namespace; the cache key folds
// (packageId, signer, feedId, priceInfoObjectId) so a chain regenesis,
// signer rotation, or PriceInfoObject re-creation invalidates each entry
// cleanly. Verify probes the cached `priceInfoObjectId` through
// `ChainProbe.getObject` per RS2 (stable identifier, not a synthesised
// shape) — if the on-chain target is gone, the cache invalidates and the
// next tick refreshes the entry.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Option, Schedule } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { ChainProbe } from '../../engine/chain-probe.js';
import { withCache } from '../../engine/cache.js';
import { StateStore } from '../../engine/state-store.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { PythError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import {
	DEFAULT_PYTH_API_URL,
	DEFAULT_HISTORICAL_HOURS,
	DEFAULT_PUSHER_REFRESH_MS,
	hexToBytes,
	type PythPriceFeedId,
} from './shared.js';

// Bare namespace for pyth-pusher cache entries — folds with `chainId` +
// canonical-JSON hash of `(packageId, signer, feedId, priceInfoObjectId)`
// to produce the per-feed cache key. Per the §8.5 cache-shape rules in
// the redesign doc, no version segment; the namespace IS the on-disk
// identity.
const STATE_KEY_PUSHER_PREFIX = 'pyth/pusher';

// Per-feed cache payload. `lastDigest` is the digest of the last
// successful update tx (today's batched update writes the same digest
// to every feed entry that participated). `priceInfoObjectId` is what
// `verify` probes through `ChainProbe.getObject` — RS2 says probe stable
// identifiers, never synthesised shapes.
interface CachedFeedPush {
	readonly lastDigest: string;
	readonly lastUpdatedMs: number;
	readonly priceInfoObjectId: string;
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
			const chain = yield* ChainProbe;

			const refreshMs = opts.refreshMs ?? DEFAULT_PUSHER_REFRESH_MS;
			const source: PythPusherSource = opts.source ?? { kind: 'benchmarks' };
			const gasBudget = opts.gasBudget ?? 200_000_000n;

			if (pyth.priceInfos.length === 0) {
				return yield* Effect.fail(
					new PythError({
						phase: 'pyth',
						message: `PythPusher(${opts.name}): no PriceInfoObjects to update`,
					}),
				);
			}

			const fetchUpdates = (
				feedIds: ReadonlyArray<PythPriceFeedId>,
			): Effect.Effect<ReadonlyArray<PythPriceUpdate>, PythError> => {
				if (source.kind === 'benchmarks') {
					const baseUrl = source.url ?? DEFAULT_PYTH_API_URL;
					const historicalHours = source.historicalHours ?? DEFAULT_HISTORICAL_HOURS;
					return fetchBenchmarks(baseUrl, historicalHours, feedIds);
				}
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

			// Build the batched update tx for one set of fresh updates. Used
			// by both the cache-miss boot tick and the steady-state loop
			// fiber. Returns the tx digest so callers can persist it to the
			// per-feed cache entries that participated.
			const runUpdateTx = (
				updates: ReadonlyArray<PythPriceUpdate>,
			): Effect.Effect<string, PythError, never> =>
				Effect.gen(function* () {
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
					return result.digest;
				});

			// Per-feed cache discipline, via the same `withCache` substrate
			// `onChainArtifact` itself wraps. We don't materialise a hidden
			// tag per feed (the outer `PythPusher` is the only tag the user
			// sees), but every per-feed entry rides the substrate's
			// canonical cache discipline:
			//
			//   - Cache key derivation (namespace + chainId + canonical hash
			//     of `(packageId, signer, feedId, priceInfoObjectId)`).
			//   - Verify probe: `chain.getObject(priceInfoObjectId)` returns
			//     `undefined` → cache invalidates → the next pass re-pushes.
			//     RS2-compliant: probes a stable id, not a synthesised
			//     shape.
			//   - State-store IO.
			//
			// `produce` returns `undefined` to mean "needs a fresh tick";
			// the OUTER loop batches every needs-refresh feed into one tx
			// and overwrites the per-feed cache entries with
			// `state.put(... , {lastDigest, ...})` once the batched tx
			// succeeds. This preserves the original "one batched tx"
			// semantics while honouring the "each feed has its own cache"
			// invariant.
			const probeFeedCache = (
				priceInfoObjectId: string,
				feedId: PythPriceFeedId,
			): Effect.Effect<Option.Option<CachedFeedPush>, never, StateStore> =>
				withCache<CachedFeedPush | undefined, never, never, never, never, never, never>({
					namespace: STATE_KEY_PUSHER_PREFIX,
					chainId: sui.chainId,
					label: `PythPusher(${opts.name}).${feedId}`,
					inputs: Effect.succeed({
						packageId: pyth.packageId,
						signer: signer.address,
						feedId,
						priceInfoObjectId,
					}),
					verify: (cached) =>
						cached === undefined
							? Effect.succeed(undefined)
							: chain
									.getObject(cached.priceInfoObjectId)
									.pipe(Effect.map((o) => (o !== undefined ? cached : undefined))),
					produce: Effect.succeed(undefined),
				}).pipe(Effect.map((v) => (v !== undefined ? Option.some(v) : Option.none())));

			// One tick: fetch fresh prices for every feed and run the
			// batched update tx. Returns the digest so the boot path can
			// persist it to per-feed cache entries.
			const tickOnceWithDigest = Effect.gen(function* () {
				const feedIds = pyth.priceInfos.map((p) => p.feedId);
				const updates = yield* fetchUpdates(feedIds);

				if (updates.length === 0) {
					yield* Effect.logWarning(
						`PythPusher(${opts.name}): no updates returned for ${feedIds.length} feeds`,
					);
					return undefined;
				}

				const digest = yield* runUpdateTx(updates);
				yield* Effect.annotateCurrentSpan({
					'pyth.pusher.lastDigest': digest,
					'pyth.pusher.feedCount': updates.length,
				});
				return digest;
			}).pipe(Effect.withSpan('PythPusher.tick'));

			// First-tick gating: only fire the synchronous boot tick if at
			// least one per-feed cache is missing or verify-failed. Warm
			// starts where every cache entry verifies become a zero-tx boot,
			// matching the publishMove cache-hit behaviour.
			let anyNeedsRefresh = false;
			for (const p of pyth.priceInfos) {
				const cached = yield* probeFeedCache(p.priceInfoObjectId, p.feedId);
				if (Option.isNone(cached)) {
					anyNeedsRefresh = true;
					break;
				}
			}

			if (anyNeedsRefresh) {
				yield* Effect.annotateCurrentSpan({ 'pyth.pusher.boot': 'refresh' });
				// First tick synchronously so configuration errors surface at
				// boot. On success, persist the digest to every per-feed
				// cache entry — the next supervisor cycle will verify them
				// and cache-hit.
				const digest = yield* tickOnceWithDigest.pipe(
					Effect.mapError(
						(cause) =>
							new PythError({
								phase: 'pusher-update',
								message: `PythPusher(${opts.name}): initial tick failed: ${stringifyCause(cause)}`,
								cause: cause as unknown as Error,
							}),
					),
				);
				if (digest !== undefined) {
					const nowMs = Date.now();
					// Persist via the same `withCache` shape (produce returns
					// the digest record). Each per-feed call writes one
					// state-store entry under the bare `pyth/pusher`
					// namespace.
					for (const p of pyth.priceInfos) {
						yield* withCache<CachedFeedPush, never, never, never, never, never, never>({
							namespace: STATE_KEY_PUSHER_PREFIX,
							chainId: sui.chainId,
							label: `PythPusher(${opts.name}).${p.feedId}`,
							inputs: Effect.succeed({
								packageId: pyth.packageId,
								signer: signer.address,
								feedId: p.feedId,
								priceInfoObjectId: p.priceInfoObjectId,
							}),
							// Force a re-derive so the produce body fires and
							// `state.put` writes the new digest. The previous
							// `probeFeedCache` already returned `Option.none()`
							// for at least one feed; calling withCache again
							// with a verify-undefined collapses to a guaranteed
							// re-put for every per-feed entry.
							verify: () => Effect.succeed(undefined),
							produce: Effect.succeed({
								lastDigest: digest,
								lastUpdatedMs: nowMs,
								priceInfoObjectId: p.priceInfoObjectId,
							} satisfies CachedFeedPush),
						});
					}
				}
			} else {
				yield* Effect.annotateCurrentSpan({ 'pyth.pusher.boot': 'cache-hit' });
				yield* Effect.logInfo(
					`PythPusher(${opts.name}): cache hit on all ${pyth.priceInfos.length} feeds — skipping boot tick`,
				);
			}

			// Steady-state loop. Forgive transient failures — schedule keeps
			// ticking. The per-feed cache is only consulted at supervisor-
			// cycle boot, not per-tick, so a flaky RPC mid-loop doesn't
			// thrash the digest record.
			const loopOnce = tickOnceWithDigest.pipe(
				Effect.catch((cause: unknown) =>
					Effect.logWarning(`PythPusher(${opts.name}): tick failed: ${stringifyCause(cause)}`),
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
			// Yields SuiTag (which folds in ChainProbe), the signer Account
			// ref, the pyth composite, and iterates `dependsOn`. Lift them
			// all into upstreams so the topo scheduler orders them ahead of
			// the pusher.
			upstreamKeys: [SuiTag.key, opts.signer, opts.pyth, ...(opts.dependsOn ?? [])],
		},
	);

export const STATE_KEY_PUSHER_PREFIX_INTERNAL = STATE_KEY_PUSHER_PREFIX;
