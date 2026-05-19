// `withCache(spec)` — the one cache discipline every primitive that
// produces on-chain or on-disk derived state uses. Centralises:
//
//   1. State-store IO (`stateStore.get` / `.put` / `.remove`).
//   2. Cache key generation — namespace + chainId + canonical-JSON hash
//      of the per-primitive inputs.
//   3. Span annotations for cache hit / miss / verify-fail.
//   4. The mandatory `verify` probe — every cache-hit value is re-
//      validated against the underlying chain or filesystem before we
//      trust it. A missing on-chain object invalidates the entry and
//      the next `produce` re-creates it.

import { Effect, Option } from 'effect';
import { contentHash } from './content-hash.js';
import { StateStore } from './state-store.js';
import { jsonBigintReplacer } from './json-bigint.js';

// -----------------------------------------------------------------------------
// CacheSpec contract
// -----------------------------------------------------------------------------

/**
 * Per-primitive cache contract. Every primitive that lands a cached
 * artifact in `StateStore` (publishMove, seal keygen, seal register,
 * walrus deploy, walrus seedWal, …) declares a `CacheSpec` and passes
 * it to {@link withCache}.
 */
export interface CacheSpec<
	T,
	EInputs = never,
	RInputs = never,
	EVerify = never,
	RVerify = never,
	EProduce = never,
	RProduce = never,
> {
	/** Static identifier of the producing primitive — folds into the
	 *  cache key alongside `chainId` so two unrelated primitives never
	 *  collide. Convention: `'<service>/<artifact>'`, e.g.
	 *  `'publishMove'` or `'walrus/deploy-output'`. */
	readonly namespace: string;

	/** Chain identifier the cached artifact is bound to. A regenesis flips
	 *  this and naturally misses the cache. Pass `sui.chainId` for
	 *  on-chain caches; pass `''` for chain-independent caches (e.g.
	 *  dockerOneShot results). */
	readonly chainId: string;

	/**
	 * Per-primitive inputs whose canonical hash forms the rest of the
	 * cache key. The shape MUST be deterministic — callers are
	 * responsible for canonicalizing (sorting nested keys, normalizing
	 * bigints to strings) BEFORE wrapping. JSON.stringify(input) feeds
	 * `contentHash` directly with the standard bigint replacer.
	 *
	 * Wrapped in `Effect.Effect` so callers can resolve runtime values
	 * (e.g. a `hashMoveSources(path)` result) at cache-key derivation
	 * time without an outer `Effect.gen`.
	 */
	readonly inputs: Effect.Effect<Record<string, unknown>, EInputs, RInputs>;

	/** Human-readable label for log messages. Emitted as
	 *  `${label}: cache hit | cache miss | cache verify-fail` so users
	 *  can see what re-ran and what was reused. Optional — defaults to
	 *  `namespace` if not provided. */
	readonly label?: string;

	/**
	 * Probe the chain (or filesystem) to verify the cached value is
	 * still valid. Returns the cached value on success, `undefined` to
	 * invalidate. A bare `Effect.succeed(cached)` opts the primitive
	 * out of verification — discouraged; every primitive that produces
	 * on-chain state should have a `verify` probe.
	 *
	 * Errors raised here are treated as "verify could not be performed"
	 * — they invalidate the entry by mapping to `undefined` (over-
	 * derive on the next `produce` rather than fail boot). Use
	 * `Effect.orElseSucceed(() => undefined)` at the implementation
	 * level when wiring an RPC probe that may transiently fail.
	 */
	readonly verify: (cached: T) => Effect.Effect<T | undefined, EVerify, RVerify>;

	/** Produce a fresh value on cache miss / verify failure. */
	readonly produce: Effect.Effect<T, EProduce, RProduce>;
}

// -----------------------------------------------------------------------------
// withCache
// -----------------------------------------------------------------------------

/**
 * Run `spec.produce` against the state-store cache. On a hit, the
 * cached value is re-validated via `spec.verify`; on a miss or verify-
 * fail, `spec.produce` runs and the result is persisted.
 *
 * Cache key shape:
 *
 *   `${namespace}/${chainId}/${contentHash(canonical(inputs))}`
 *
 * `chainId` is omitted from the key when empty (chain-independent
 * caches); otherwise it lives in the middle slot so `wipe`-style
 * tooling can grep all entries for a given chain by prefix.
 *
 * Span annotations attached to the surrounding span:
 *   - `cache.namespace`
 *   - `cache.key`
 *   - `cache.outcome` ∈ {'hit', 'miss', 'verify-fail'}
 */
export const withCache = <
	T,
	EInputs = never,
	RInputs = never,
	EVerify = never,
	RVerify = never,
	EProduce = never,
	RProduce = never,
>(
	spec: CacheSpec<T, EInputs, RInputs, EVerify, RVerify, EProduce, RProduce>,
): Effect.Effect<T, EInputs | EVerify | EProduce, RInputs | RVerify | RProduce | StateStore> =>
	Effect.gen(function* () {
		const state = yield* StateStore;
		const inputs = yield* spec.inputs;
		const inputsHash = contentHash(JSON.stringify(inputs, jsonBigintReplacer), { length: 16 });
		const key = buildCacheKey({
			namespace: spec.namespace,
			chainId: spec.chainId,
			inputsHash,
		});
		yield* Effect.annotateCurrentSpan({
			'cache.namespace': spec.namespace,
			'cache.key': key,
		});

		const label = spec.label ?? spec.namespace;
		const cached = yield* state.get<T>(key);
		if (Option.isSome(cached)) {
			const verified = yield* spec.verify(cached.value);
			if (verified !== undefined) {
				yield* Effect.annotateCurrentSpan({ 'cache.outcome': 'hit' });
				yield* Effect.logInfo(`${label}: cache hit`);
				return verified;
			}
			yield* Effect.annotateCurrentSpan({ 'cache.outcome': 'verify-fail' });
			yield* Effect.logInfo(`${label}: cache verify-fail`);
			// Eviction. Best-effort — a state-store IO defect mustn't
			// fail the primitive; we'll just over-produce on the next
			// cycle.
			yield* state.remove(key).pipe(Effect.ignore);
		} else {
			yield* Effect.annotateCurrentSpan({ 'cache.outcome': 'miss' });
			yield* Effect.logInfo(`${label}: cache miss`);
		}

		const fresh = yield* spec.produce;
		yield* state.put(key, fresh).pipe(Effect.ignore);
		return fresh;
	});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build the canonical cache key. Exported for callsites that need to
 * pre-compute the key (e.g. for instrumentation).
 *
 * Layout:
 *   - `<namespace>/<chainId>/<inputsHash>` when `chainId` is non-empty
 *   - `<namespace>/<inputsHash>` when `chainId` is empty
 */
export const buildCacheKey = (args: {
	readonly namespace: string;
	readonly chainId: string;
	readonly inputsHash: string;
}): string =>
	args.chainId.length === 0
		? `${args.namespace}/${args.inputsHash}`
		: `${args.namespace}/${args.chainId}/${args.inputsHash}`;
