// Cache implementation.
//
// Universal artifact cache, content-addressed by
// `(namespace, chain, contentHash)`. Per-plugin namespace; `chain` is a
// plain string key the substrate forwards verbatim (it does NOT fold its
// own `identity.network` in — that keeps warm-restart ids stable).
//
// Semantics:
//
//   - `lookup` is the precise "is the entry present?" query. Hit
//     returns `CacheEntry`; miss returns `null`. Schema-decode
//     failure (corruption) is treated as a MISS, not an error —
//     re-producing the artifact is always safe; surfacing decode
//     failures would force every caller to handle a recovery path
//     they don't need. The corruption is logged via the span.
//   - `write` is best-effort. The architecture is explicit: an
//     ArtifactPublisher commits the on-chain effect, THEN
//     writes the cache; a cache-write IO failure must NOT roll back
//     the on-chain effect. We surface write failures via the
//     `CacheError` channel so callers can opt into reporting them,
//     but the typical caller pipes `Effect.ignore` over the write.
//   - `delete` is a best-effort sweep.
//
// Tombstones: the cache does NOT use tombstones. Missing-vs-deleted
// is meaningless for a content-addressed best-effort store —
// re-producing the artifact has the same effect either way.

import { Context, Effect, FileSystem, Layer, type Scope } from 'effect';

import type { ArtifactPublishError, ArtifactSpec } from '../../../primitives/artifact-publisher.ts';
import type { Cache, CacheEntry, CacheKey } from '../../../primitives/cache.ts';
import { atomicWriteJson } from '../atomic-write.ts';
import { setCurrentPluginPhase } from '../current-plugin.ts';
import { CacheError } from '../errors.ts';
import { StackPathsService } from '../paths.ts';
import { decodeJsonText, parseJsonTextSync } from '../runtime-decode.ts';
import { CacheEntryDoc } from './schema.ts';

const base64Encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const base64Decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

// Encode / decode the cached `publish` payload. We serialize `Produced`
// as JSON. The artifact spec doesn't bake a codec in (`Produced` is
// generic); JSON round-trip matches existing plugin call sites
// (`CachedPackageEntry`, `CachedMint`, etc. are JSON-shaped).
const encodePayload = (value: unknown): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(value));

const decodePayload = <Produced>(bytes: Uint8Array): Produced | null => {
	try {
		return parseJsonTextSync(new TextDecoder().decode(bytes), {
			source: 'artifact-publisher cache payload',
			mkError: (issue) => issue,
		}) as Produced;
	} catch {
		return null;
	}
};

export class CacheService extends Context.Service<CacheService, Cache>()(
	'@devstack/substrate/Cache',
) {}

/**
 * Cache Layer. Stateless beyond the path resolver and the platform
 * FileSystem — every read goes to disk (no in-memory hot cache; the
 * OS page cache is enough). If a future perf pass shows the
 * substrate is hot-path-reading the same entries repeatedly, fold
 * an LRU in here; today's call-sites read once at acquire and never
 * again.
 */
export const layerCache: Layer.Layer<
	CacheService,
	never,
	FileSystem.FileSystem | StackPathsService
> = Layer.effect(
	CacheService,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* StackPathsService;

		const lookup = (key: CacheKey): Effect.Effect<CacheEntry | null, CacheError> =>
			Effect.gen(function* () {
				const { file } = paths.cacheEntry(key.namespace, key.chain, key.contentHash);
				const exists = yield* fs.exists(file).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CacheError({
								reason: 'io-failed',
								detail: `failed to stat cache entry: ${file}`,
								cause,
							}),
						),
					),
				);
				if (!exists) return null;
				const text = yield* fs.readFileString(file).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CacheError({
								reason: 'io-failed',
								detail: `failed to read cache entry: ${file}`,
								cause,
							}),
						),
					),
				);
				// Corruption = miss. The cache contract is
				// best-effort; surfacing decode failures would force
				// every caller to handle a recovery path that's
				// already implicit (re-produce). We annotate the span
				// AND emit a `logDebug` so the rare corruption is
				// visible in the log stream, not only via span backend.
				const doc = yield* decodeJsonText(CacheEntryDoc, text, {
					source: file,
					mkError: (issue) => issue,
				}).pipe(
					Effect.tapCause((cause) =>
						Effect.logDebug('cache entry decode failed; treating as miss', {
							file,
							cause,
						}),
					),
					Effect.catch(() => Effect.succeed(null as CacheEntryDoc | null)),
				);
				if (doc === null) return null;
				return {
					bytes: base64Decode(doc.bytes),
					writtenAt: doc.writtenAt,
				};
			});

		const write = (key: CacheKey, bytes: Uint8Array): Effect.Effect<void, CacheError> =>
			Effect.gen(function* () {
				const { file } = paths.cacheEntry(key.namespace, key.chain, key.contentHash);
				const doc: CacheEntryDoc = {
					version: 1,
					bytes: base64Encode(bytes),
					writtenAt: Date.now(),
				};
				yield* atomicWriteJson(file, CacheEntryDoc, doc, {
					mode: 0o644,
					parentMode: 0o755,
				}).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CacheError({
								reason: 'io-failed',
								detail: `cache write failed: ${file}`,
								cause,
							}),
						),
					),
					Effect.provideService(FileSystem.FileSystem, fs),
				);
			});

		const remove = (key: CacheKey): Effect.Effect<void, CacheError> =>
			Effect.gen(function* () {
				const { file } = paths.cacheEntry(key.namespace, key.chain, key.contentHash);
				yield* fs.remove(file, { force: true }).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CacheError({
								reason: 'io-failed',
								detail: `cache delete failed: ${file}`,
								cause,
							}),
						),
					),
				);
			});

		// publish: cache → verify → produce → register.
		//
		// Architecture §10: the substrate primitive that orchestrates the
		// cycle every on-chain produce/verify plugin (package, coin, walrus
		// deploy, seal deploy, deepbook deploy, etc.) flows through. Folds in
		// the former `ArtifactPublisher` facade, closing over the LOCAL
		// `lookup`/`write` above. The (namespace, chain, contentHash) triple
		// is the sole cache key; `spec.chain` (the plugin-supplied HEX
		// on-chain id) is forwarded VERBATIM — the substrate does NOT fold
		// `identity.network` in, which is what keeps warm-restart ids stable.
		const publish = <Produced, Verified>(
			spec: ArtifactSpec<Produced, Verified>,
		): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
			Effect.gen(function* () {
				// 1. Cache lookup. Best-effort: a CacheError on lookup
				//    surfaces as `cache-corrupt`; the substrate's contract
				//    is "re-produce is always safe", so we coerce read
				//    failures to a miss rather than abort the cycle.
				const hit = yield* lookup({
					namespace: spec.namespace,
					chain: spec.chain,
					contentHash: spec.contentHash,
				}).pipe(Effect.catch(() => Effect.succeed(null)));

				if (hit !== null) {
					// Decode the cached `Produced` BEFORE verify so the
					// plugin's verify Effect can key its on-chain probe
					// off a field of the cached payload (e.g. action's
					// `digest`, package's `packageId`). A decode failure
					// here is "cache corruption" — drop through to
					// re-produce so the cycle is still safe.
					const cached = decodePayload<Produced>(hit.bytes);
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
					yield* Effect.logInfo(
						`artifact-publisher: producing '${spec.namespace}' on chain ${spec.chain} — ` +
							`no cached artifact for this chain + content hash ` +
							`(first deploy on this chain, fresh genesis after a restart, or changed inputs).`,
					);
				} else {
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
				yield* write(
					{
						namespace: spec.namespace,
						chain: spec.chain,
						contentHash: spec.contentHash,
					},
					encodePayload(produced),
				).pipe(Effect.catch(() => Effect.void));

				// 5. Register — fires on EVERY cycle (architecture §10).
				yield* spec.register(produced);
				return produced;
			});

		return CacheService.of({
			lookup,
			write,
			delete: remove,
			publish,
		});
	}),
);
