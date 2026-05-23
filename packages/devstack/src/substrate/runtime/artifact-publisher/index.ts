// ArtifactPublisher — substrate-level service.
//
// Architecture §10: substrate primitive that orchestrates the
// `cache → verify → produce → register` cycle every on-chain
// produce/verify plugin (package, coin, walrus deploy, seal deploy,
// deepbook deploy, etc.) flows through.
//
// Plugins call `publisher.publish(spec)` with their per-cycle
// `ArtifactSpec<Produced, Verified>` (namespace, chain,
// contentHash, verifySchema, verify, produce, register). The
// substrate handles:
//
//   1. `cache.lookup({namespace, chain, contentHash})`. Hit AND
//      `spec.verify` returns a non-null value → `register`(decoded
//      cached payload) and return.
//   2. Miss OR verify-returned-null → run `spec.produce` under the
//      caller's Scope; on success, write the produced payload to
//      the cache (best-effort, errors logged but not propagated);
//      then `register(produced)`.
//
// The substrate carries the cache + chain-probe seams via Layers
// (CacheService, StrategyRegistryService). Plugins yield this
// service from their acquire body; the supervisor injects it via
// pluginContext.
//
// Cache payload codec: we serialize `Produced` as JSON. The artifact publisher
// spec doesn't bake a codec in (`Produced` is generic); JSON
// round-trip matches existing plugin call sites
// (`CachedPackageEntry`, `CachedMint`, etc. are JSON-shaped).

import { Context, Effect, Layer, Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
	ArtifactSpec,
} from '../../../primitives/artifact-publisher.ts';
import { CacheService } from '../cache/index.ts';
import { parseJsonTextSync } from '../runtime-decode.ts';

// Re-export the ChainOperation typed seam — plugin authors compose
// produce bodies via `compileChainOperation({...})` rather than
// hand-rolling the `Effect<Produced, ArtifactPublishError, Scope>`.
//
// `ResolvedSigner` is intentionally NOT re-exported here — it is
// owned by `sui-execute/` and reached via that module's barrel; both
// modules share the single canonical shape.
export {
	compileChainOperation,
	type ChainOperation,
	type OneShotRunner,
	type OneShotSpec,
	type SuiEffects,
	type SuiTxBuilder,
} from './chain-operation.ts';

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

/**
 * Substrate-level service projecting the
 * `ArtifactPublisher` primitive. Plugins yield this tag in
 * their acquire body; the supervisor's `pluginContext` carries it.
 *
 * The service is constructed once per stack (Layer-driven) and
 * closes over the per-stack Cache + StrategyRegistry. Parallel
 * stacks isolate by construction — each stack's Layer build is
 * independent.
 */
export class ArtifactPublisherService extends Context.Service<
	ArtifactPublisherService,
	ArtifactPublisher
>()('@devstack-rewrite/substrate/ArtifactPublisher') {}

// ---------------------------------------------------------------------------
// Encode / decode the cached payload
// ---------------------------------------------------------------------------

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const decode = <Produced>(bytes: Uint8Array): Produced | null => {
	try {
		return parseJsonTextSync(new TextDecoder().decode(bytes), {
			source: 'artifact-publisher cache payload',
			mkError: (issue) => issue,
		}) as Produced;
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------------------
// Publish: cache → verify → produce → register
// ---------------------------------------------------------------------------

const makePublisher = (cache: typeof CacheService.Service): ArtifactPublisher => ({
	publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	): Effect.Effect<Produced | Verified, ArtifactPublishError, Scope.Scope> =>
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'artifactPublisher.namespace': spec.namespace,
				'artifactPublisher.chain': spec.chain,
				'artifactPublisher.contentHash': spec.contentHash,
			});

			// 1. Cache lookup. Best-effort: a CacheError on lookup
			//    surfaces as `cache-corrupt`; the substrate's contract
			//    is "re-produce is always safe", so we coerce read
			//    failures to a miss rather than abort the cycle.
			const hit = yield* cache
				.lookup({
					namespace: spec.namespace,
					chain: spec.chain,
					contentHash: spec.contentHash,
				})
				.pipe(Effect.catch(() => Effect.succeed(null)));

			if (hit !== null) {
				// Decode the cached `Produced` BEFORE verify so the
				// plugin's verify Effect can key its on-chain probe
				// off a field of the cached payload (e.g. action's
				// `digest`, package's `packageId`). A decode failure
				// here is "cache corruption" — drop through to
				// re-produce so the cycle is still safe.
				const cached = decode<Produced>(hit.bytes);
				if (cached !== null) {
					// 2. Verify (lenient — returns null on transient
					//    failure or not-found). Architecture §10:
					//    verify-on-hit covers chain-state drift.
					const verified = yield* spec.verify(cached);
					if (verified !== null) {
						const payload: Produced | Verified = cached;
						yield* spec.register(payload);
						yield* Effect.annotateCurrentSpan({ 'artifactPublisher.path': 'hit' });
						return payload;
					}
				}
			}

			// 3. Miss or verify-failed → produce.
			yield* Effect.annotateCurrentSpan({
				'artifactPublisher.path': hit === null ? 'miss' : 'verify-failed',
			});
			const produced = yield* spec.produce;

			// 4. Cache write — best-effort. Architecture: a write
			//    failure must NOT roll back the on-chain effect.
			yield* cache
				.write(
					{
						namespace: spec.namespace,
						chain: spec.chain,
						contentHash: spec.contentHash,
					},
					encode(produced),
				)
				.pipe(Effect.catch(() => Effect.void));

			// 5. Register — fires on EVERY cycle (architecture §10).
			yield* spec.register(produced);
			return produced;
		}).pipe(Effect.withSpan('substrate.artifactPublisher.publish')),
});

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Layer that materializes the publisher from the substrate's
 * Cache service. Plugins yield `ArtifactPublisherService`;
 * the supervisor provides it via `pluginContext`.
 *
 * The publisher is service-name-blind: it reaches `CacheService`
 * via the Context, NOT through a hard-coded import edge with any
 * plugin. Chain-probe lookup is the caller's concern — the spec's
 * `verify` Effect closes over the probe.
 */
export const layerArtifactPublisher: Layer.Layer<ArtifactPublisherService, never, CacheService> =
	Layer.effect(
		ArtifactPublisherService,
		Effect.gen(function* () {
			const cache = yield* CacheService;
			return ArtifactPublisherService.of(makePublisher(cache));
		}),
	);
