// CoinMetadata fetch + soft-degradation.
//
// Distilled-doc 13-coin.md Invariant 8: `getCoinMetadata` failures
// degrade, do not throw. A timeout or RPC error after one retry
// returns `null` (logged as a warning); the discovery pipeline keeps
// going. The next supervisor cycle picks the missing record up.
//
// Per-attempt timeout 5s, ONE retry at 250ms backoff (matches the v3
// `RETRY_SCHEDULE` exactly — distilled-doc 13-coin.md §Configuration).
//
// In-process per-Layer-invocation cache keyed by fullCoinType. The
// fullCoinType folds the packageId, so a fresh chain (new genesis)
// means new packageIds, which means the cache misses naturally —
// persistence across restart is unnecessary.

import { Effect, Ref, Schema } from 'effect';

import { decodeUnknown } from '../../substrate/runtime/runtime-decode.ts';
import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';
import { makeSpacedRetrySchedule } from '../../substrate/runtime/retry-policy.ts';
import { coinError, type CoinError } from './errors.ts';
import { CoinSpans } from './spans.ts';

/** Per-attempt timeout (5 seconds) — distilled-doc invariant. */
export const METADATA_FETCH_TIMEOUT_MS = 5_000;

/** Retry schedule — ONE retry at 250ms backoff. Matches the v3
 *  `RETRY_SCHEDULE` (250ms spaced, bounded to one retry). */
export const METADATA_RETRY_SCHEDULE = makeSpacedRetrySchedule(250, 1);

/** On-chain CoinMetadata projection — narrowed to the columns the
 *  registry needs. The SDK's full shape carries more (description,
 *  raw bytes); we don't.
 *
 *  IMPORTANT (chain-probe schema constraint from the last sweep):
 *  this Schema MUST NOT depend on any services. `Schema.Schema<T>` is
 *  parameterized `<Type, Encoded, R, RD>`; we constrain `R` and `RD`
 *  to `never` via `Schema.Codec<T, unknown, never, never>` at the
 *  consumer boundary, but the schema literal itself uses ONLY
 *  service-free combinators (`Schema.String`, `Schema.Number`,
 *  `Schema.optional`). */
export const OnchainCoinMetadataShape = Schema.Struct({
	id: Schema.String,
	decimals: Schema.Number,
	name: Schema.String,
	symbol: Schema.String,
	description: Schema.optional(Schema.String),
	iconUrl: Schema.optional(Schema.String),
});

export type OnchainCoinMetadata = typeof OnchainCoinMetadataShape.Type;

/** SDK shim — the surface the discovery pass calls. The Sui plugin's
 *  resolved client exposes this via `sdk.core.getCoinMetadata`. Kept
 *  narrow (no `@mysten/sui` type import) so this module stays
 *  layering-neutral; the consumer hands in the resolved client. */
export interface MetadataSdkShim {
	readonly core: {
		readonly getCoinMetadata: (args: { readonly coinType: string }) => Promise<unknown>;
	};
}

/** Per-Layer-invocation cache. `null` means "we tried and the RPC
 *  said the coin had no CoinMetadata"; `undefined` means "we haven't
 *  asked yet". */
export interface CoinMetadataCache {
	readonly get: (fullCoinType: string) => Effect.Effect<OnchainCoinMetadata | null | undefined>;
	readonly put: (fullCoinType: string, value: OnchainCoinMetadata | null) => Effect.Effect<void>;
}

/** Build an empty cache. */
export const makeCoinMetadataCache = (): Effect.Effect<CoinMetadataCache> =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<Record<string, OnchainCoinMetadata | null>>({});
		return {
			get: (fullCoinType) =>
				Ref.get(ref).pipe(Effect.map((m) => (fullCoinType in m ? m[fullCoinType] : undefined))),
			put: (fullCoinType, value) => Ref.update(ref, (m) => ({ ...m, [fullCoinType]: value })),
		};
	});

/** Fetch CoinMetadata for one coin type. Soft-degrades on RPC
 *  failure / timeout: returns `null` after the retry budget is
 *  exhausted, AND logs a warning.
 *
 *  Distilled-doc 13-coin.md Invariant 8: this is intentional. The
 *  publish-discovery pass must not fail the whole supervisor cycle on
 *  a flaky RPC blip. */
export const fetchCoinMetadataOnce = (
	sdk: MetadataSdkShim,
	fullCoinType: string,
): Effect.Effect<OnchainCoinMetadata | null> =>
	Effect.gen(function* () {
		const raw: unknown = yield* Effect.tryPromise({
			try: () => sdk.core.getCoinMetadata({ coinType: fullCoinType }),
			catch: (cause): { readonly _tag: 'rpc'; readonly cause: unknown } => ({
				_tag: 'rpc',
				cause,
			}),
		}).pipe(
			// Effect v4: `timeoutOrElse` (not `timeoutFail`). The
			// `orElse` branch is the new value (Effect), not just an
			// error constructor — we surface a tagged failure that the
			// downstream `Effect.catch` swallows into `null`.
			Effect.timeoutOrElse({
				duration: `${METADATA_FETCH_TIMEOUT_MS} millis`,
				orElse: () => Effect.fail({ _tag: 'rpc' as const, cause: 'timeout' }),
			}),
			Effect.retry(METADATA_RETRY_SCHEDULE),
			Effect.catch((err): Effect.Effect<unknown> => {
				return Effect.logWarning('coin metadata fetch failed; soft-degrading to null').pipe(
					Effect.annotateLogs({
						[CoinSpans.type]: fullCoinType,
						[SpanAttr.errorCause]: stringifyCause(err.cause),
					}),
					Effect.as(null),
				);
			}),
		);
		if (raw === null || raw === undefined) return null;
		return yield* decodeUnknown(OnchainCoinMetadataShape, raw, {
			source: 'coin metadata RPC response',
			mkError: (issue) => issue,
		}).pipe(
			Effect.catch((issue) =>
				Effect.logWarning(
					'coin metadata response had non-conforming shape; degrading to null',
				).pipe(
					Effect.annotateLogs({
						[CoinSpans.type]: fullCoinType,
						[SpanAttr.errorCause]: stringifyCause(issue.cause ?? issue),
					}),
					Effect.as(null as OnchainCoinMetadata | null),
				),
			),
		);
	}).pipe(
		Effect.withSpan('coin.metadata.fetch', {
			attributes: { [CoinSpans.metadata.fullCoinType]: fullCoinType },
		}),
	);

/** Batch-fetch with cache. Each fullCoinType is asked at most once
 *  per Layer-invocation. The fetches run concurrently — distilled-doc
 *  opportunity ("Coin discovery is naturally batchable"). */
export const fetchCoinMetadataMany = (
	sdk: MetadataSdkShim,
	fullCoinTypes: ReadonlyArray<string>,
	cache: CoinMetadataCache,
): Effect.Effect<ReadonlyMap<string, OnchainCoinMetadata | null>> =>
	Effect.gen(function* () {
		const result = new Map<string, OnchainCoinMetadata | null>();
		yield* Effect.forEach(
			fullCoinTypes,
			(fullCoinType) =>
				Effect.gen(function* () {
					const cached = yield* cache.get(fullCoinType);
					if (cached !== undefined) {
						result.set(fullCoinType, cached);
						return;
					}
					const fetched = yield* fetchCoinMetadataOnce(sdk, fullCoinType);
					yield* cache.put(fullCoinType, fetched);
					result.set(fullCoinType, fetched);
				}),
			{ concurrency: 'unbounded' },
		);
		return result;
	});

/** Bare-coin-type heuristic — distilled-doc 13-coin.md Invariant 3.
 *
 *  MUST agree with what `getCoinMetadata` accepts as a coin-type
 *  argument: `0xHEX::module::Witness`. Anything else (symbol, witness
 *  alone) falls through to the registry path. */
export const isBareCoinType = (s: string): boolean => {
	if (!s.startsWith('0x')) return false;
	if (!s.includes('::')) return false;
	if (s.split('::').length !== 3) return false;
	// Distilled-doc invariant 7: nested generics rejected at the
	// bare-string boundary too. The check fires before the RPC so
	// callers see a typed error rather than a downstream decode
	// failure.
	if (s.includes('<') || s.includes('>')) return false;
	return true;
};

/** Project a coin-type validation failure to `CoinError`. Surfaces
 *  the nested-generic case at the user-facing factory boundary. */
export const validateBareCoinType = (identifier: string): CoinError | null => {
	if (identifier.includes('<') || identifier.includes('>')) {
		return coinError('nested-generic', {
			identifier,
			message: `coin('${identifier}'): nested generics not supported.`,
		});
	}
	return null;
};

const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
