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
import { setCurrentPluginPhase } from '../current-plugin.ts';
import { SpanAttr } from '../observability/spans.ts';
import { parseJsonTextSync } from '../runtime-decode.ts';

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
>()('@devstack/substrate/ArtifactPublisher') {}

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
	): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				[SpanAttr.artifactPublisherNamespace]: spec.namespace,
				[SpanAttr.artifactPublisherChain]: spec.chain,
				[SpanAttr.artifactPublisherContentHash]: spec.contentHash,
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
						// The substrate always returns the decoded
						// `Produced` payload — the `Verified` shape is a
						// probe-only signal that never escapes. Callers
						// therefore type-narrow trivially against `Produced`.
						yield* spec.register(cached);
						yield* Effect.annotateCurrentSpan({ [SpanAttr.artifactPublisherPath]: 'hit' });
						// Reuse is the quiet, expected warm-restart path — debug
						// only. The interesting (and noisy) case is a *re-run*,
						// logged below.
						yield* Effect.logDebug(
							`artifact-publisher: reusing cached '${spec.namespace}' on chain ${spec.chain} ` +
								`(cache hit; no re-deploy).`,
						);
						return cached;
					}
				}
			}

			// 3. Miss or verify-failed → produce. State WHEN and WHY loudly:
			//    on a restart this is the line that explains why an on-chain
			//    id is about to change. A fresh chain genesis misses every
			//    cache key (keyed by chain id), so packages / key servers /
			//    walrus all get brand-new ids, and content bound to the old
			//    ids (e.g. Seal-encrypted blobs) can no longer be resolved.
			if (hit === null) {
				yield* Effect.annotateCurrentSpan({ [SpanAttr.artifactPublisherPath]: 'miss' });
				yield* Effect.logInfo(
					`artifact-publisher: producing '${spec.namespace}' on chain ${spec.chain} — ` +
						`no cached artifact for this chain + content hash ` +
						`(first deploy on this chain, fresh genesis after a restart, or changed inputs).`,
				);
			} else {
				yield* Effect.annotateCurrentSpan({
					[SpanAttr.artifactPublisherPath]: 'verify-failed',
				});
				yield* Effect.logWarning(
					`artifact-publisher: re-deploying '${spec.namespace}' on chain ${spec.chain} — ` +
						`a cached artifact existed but failed on-chain verification ` +
						`(object missing, or RPC unavailable during restart); a new id will replace ` +
						`the prior deployment.`,
				);
				// Effect logs are dropped under the `up` TUI (Logger.layer([])).
				// The verify-failed re-deploy is the anomalous restart case — a
				// cached id existed but is no longer resolvable — so narrate it
				// on the supervised plugin's row, the channel the TUI renders.
				// (A plain cache miss stays quiet here: on a cold boot every
				// artifact misses, and the plugin narrates its own publish.)
				yield* setCurrentPluginPhase(
					`re-deploying ${spec.namespace} (cached artifact failed verification on restart)`,
				);
			}
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
