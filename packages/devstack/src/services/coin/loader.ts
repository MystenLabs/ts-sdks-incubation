// CoinMetadataLoader — process-lifetime Effect.Service caching the gRPC
// `getCoinMetadata` RPC payload per coin type. The publish-discovery
// pass calls `getMany` after `publishMove` to fold symbol / decimals /
// name / iconUrl into the `CoinRecord`s the manifest emits.
//
// Why cache: a typical app publishes ~2 coins per supervisor cycle, and
// a hot-restart re-runs publish (cache-hit branch in `internal.ts`); the
// RPC payload doesn't move between cycles. Caching cuts the per-cycle
// cost from O(coinCount * 50-100ms) to O(0).
//
// Why per-process (not in-StateStore): the metadata is keyed by full
// coin type, which already folds the packageId. A fresh chain (new
// genesis) means new packageIds, which means the cache misses naturally.
// Persisting across `runOneShot` boundaries is unnecessary — both ends
// of the boundary re-derive from a fresh publish receipt.
//
// Retry: one retry at 250ms backoff on transient RPC failure (timeout,
// network blip). Beyond that, the loader returns `Option.none()` so the
// discovery pipeline keeps going — a missing metadata is degraded
// behavior (`decimals` undefined, faucet skips the coin), not fatal.

import { Context, Effect, Layer, Option, Ref as EffectRef, Schedule } from 'effect';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiTag } from '../sui.js';
import { stringifyCause } from '../../engine/stringify-cause.js';

/** Subset of the gRPC `getCoinMetadata` payload primitives consume.
 *
 *  Note: `iconUrl` may be `null` in the gRPC response (proto3 nullable);
 *  we surface it as `string | undefined` to match the optional-field
 *  convention used everywhere else in the package. `null` is treated as
 *  "no icon". */
export interface OnchainCoinMetadata {
	readonly id: string | null;
	readonly decimals: number;
	readonly name: string;
	readonly symbol: string;
	readonly description: string;
	readonly iconUrl?: string;
}

/** Loader contract — methods `get` / `getMany` resolve to `Option`s so
 *  callers can branch on "coin has no on-chain metadata" without an
 *  error path. Coins minted via a custom init that bypasses
 *  `coin::create_currency` legally have no metadata; degrading
 *  gracefully there is part of the contract. */
export interface CoinMetadataLoaderShape {
	readonly get: (coinType: string) => Effect.Effect<Option.Option<OnchainCoinMetadata>>;
	readonly getMany: (
		coinTypes: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyMap<string, OnchainCoinMetadata>>;
}

export class CoinMetadataLoader extends Context.Service<
	CoinMetadataLoader,
	CoinMetadataLoaderShape
>()('@devstack/CoinMetadataLoader') {}

// Per-attempt timeout — the gRPC SDK doesn't enforce an upper bound on
// `getCoinMetadata`. A wedged RPC (DNS hang, slow validator) would
// otherwise hold up publish completion indefinitely; 5s is generous
// for a healthy localnet (typically <100ms) and surfaces the wedge
// quickly enough that the user sees actionable output instead of a
// hang.
const GET_COIN_METADATA_TIMEOUT_MS = 5_000;

// One retry at 250ms backoff. Beyond that, the coin records as
// "no metadata" and the discovery pipeline keeps going. This is
// deliberate: a flaky publish-time RPC blip shouldn't fail the whole
// supervisor cycle; the next cycle re-runs (cache-miss on `getCoinMetadata`)
// and typically picks up the metadata that wasn't ready yet.
//
// `Schedule.spaced('250 millis').pipe(Schedule.both(Schedule.recurs(1)))`
// caps the retry at exactly one re-attempt — matches the engine/faucet.ts
// `Schedule.both(Schedule.recurs(N))` convention. (`spaced` alone retries
// forever; `recurs` alone retries with zero delay.)
const RETRY_SCHEDULE = Schedule.spaced('250 millis').pipe(Schedule.both(Schedule.recurs(1)));

/** Pure helper — fetch one coin's on-chain metadata against a
 *  caller-supplied gRPC client. Used by the `CoinMetadataLoaderLive`
 *  layer (the cached service-shape entry point) AND by `publishMove`
 *  directly (which calls the helper inline with its own client to
 *  avoid layer-plumbing the Service into the publish path).
 *
 *  Same retry / timeout / degrade behavior as `CoinMetadataLoader.get`:
 *  one 250ms-backoff retry on transient RPC failure, then degrade to
 *  `Option.none()` with a warning log. The publish pipeline keeps
 *  running so a flaky publish-time RPC blip doesn't fail the whole
 *  supervisor cycle. */
export const fetchCoinMetadataOnce = (
	client: SuiGrpcClient,
	coinType: string,
): Effect.Effect<Option.Option<OnchainCoinMetadata>> =>
	Effect.tryPromise({
		try: () => client.core.getCoinMetadata({ coinType }),
		catch: (cause) => new Error(`getCoinMetadata(${coinType}): ${stringifyCause(cause)}`),
	}).pipe(
		Effect.timeoutOrElse({
			duration: `${GET_COIN_METADATA_TIMEOUT_MS} millis`,
			orElse: () =>
				Effect.fail(
					new Error(
						`getCoinMetadata(${coinType}) timed out after ${GET_COIN_METADATA_TIMEOUT_MS}ms`,
					),
				),
		}),
		Effect.retry(RETRY_SCHEDULE),
		Effect.map((response) => {
			const md = response.coinMetadata;
			if (md === null || md === undefined) return Option.none();
			const projected: OnchainCoinMetadata = {
				id: md.id,
				decimals: md.decimals,
				name: md.name,
				symbol: md.symbol,
				description: md.description,
				...(typeof md.iconUrl === 'string' && md.iconUrl.length > 0
					? { iconUrl: md.iconUrl }
					: {}),
			};
			return Option.some(projected);
		}),
		Effect.catch((cause: Error) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					`fetchCoinMetadataOnce(${coinType}): RPC failed after retry, ` +
						`treating as "no metadata available" — ${cause.message}`,
				);
				return Option.none<OnchainCoinMetadata>();
			}),
		),
		Effect.withSpan('CoinMetadataLoader.fetch', {
			attributes: { 'coin.type': coinType },
		}),
	);

/** Pure helper — fetch many coins' metadata concurrently. De-dupes
 *  input coin types before dispatch. Returns a map keyed by canonical
 *  coin type; coin types whose RPC degraded to `Option.none()` are
 *  silently absent from the result map (consumers decide whether to
 *  warn or skip). */
export const fetchCoinMetadataMany = (
	client: SuiGrpcClient,
	coinTypes: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, OnchainCoinMetadata>> =>
	Effect.gen(function* () {
		if (coinTypes.length === 0) return new Map() as ReadonlyMap<string, OnchainCoinMetadata>;
		const unique = Array.from(new Set(coinTypes));
		const results = yield* Effect.forEach(unique, (ct) => fetchCoinMetadataOnce(client, ct), {
			concurrency: 'unbounded',
		});
		const out = new Map<string, OnchainCoinMetadata>();
		for (let i = 0; i < unique.length; i++) {
			const md = results[i];
			if (md !== undefined && Option.isSome(md)) {
				out.set(unique[i] as string, md.value);
			}
		}
		return out as ReadonlyMap<string, OnchainCoinMetadata>;
	});

/** Live layer for the loader. Reads `SuiTag.client` to dispatch the
 *  underlying gRPC call. Caches keyed by canonical coin type. Built on
 *  top of the pure `fetchCoinMetadataOnce` helper above; the only
 *  thing the Layer adds is the in-process cache + `Context.Service`
 *  shape downstream `yield* CoinMetadataLoader` consumers want. */
export const CoinMetadataLoaderLive: Layer.Layer<CoinMetadataLoader, never, SuiTag> = Layer.effect(
	CoinMetadataLoader,
	Effect.gen(function* () {
		const sui = yield* SuiTag;
		const cache = yield* EffectRef.make(new Map<string, OnchainCoinMetadata>());

		const get: CoinMetadataLoaderShape['get'] = (coinType) =>
			Effect.gen(function* () {
				const current = yield* EffectRef.get(cache);
				const cached = current.get(coinType);
				if (cached !== undefined) return Option.some(cached);
				const fetched = yield* fetchCoinMetadataOnce(sui.client, coinType);
				if (Option.isSome(fetched)) {
					yield* EffectRef.update(cache, (m) => {
						const next = new Map(m);
						next.set(coinType, fetched.value);
						return next;
					});
				}
				return fetched;
			});

		const getMany: CoinMetadataLoaderShape['getMany'] = (coinTypes) =>
			Effect.gen(function* () {
				if (coinTypes.length === 0) return new Map() as ReadonlyMap<string, OnchainCoinMetadata>;
				const unique = Array.from(new Set(coinTypes));
				const results = yield* Effect.forEach(unique, (coinType) => get(coinType), {
					concurrency: 'unbounded',
				});
				const out = new Map<string, OnchainCoinMetadata>();
				for (let i = 0; i < unique.length; i++) {
					const md = results[i];
					if (md !== undefined && Option.isSome(md)) {
						out.set(unique[i] as string, md.value);
					}
				}
				return out as ReadonlyMap<string, OnchainCoinMetadata>;
			});

		return { get, getMany };
	}),
);
