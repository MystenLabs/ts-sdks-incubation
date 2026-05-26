// Cache implementation.
//
// Universal artifact cache, content-addressed by
// `(namespace, chainId, contentHash)`. Per-plugin namespace; the
// substrate folds chainId in.
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

import { Context, Effect, FileSystem, Layer } from 'effect';

import type { Cache, CacheEntry, CacheKey } from '../../../primitives/cache.ts';
import { atomicWriteJson } from '../atomic-write.ts';
import { CacheError } from '../errors.ts';
import { StackPathsService } from '../paths.ts';
import { decodeJsonText } from '../runtime-decode.ts';
import { CacheEntryDoc } from './schema.ts';

const base64Encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const base64Decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

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
				// already implicit (re-produce). We do annotate the
				// span so the substrate's observability still
				// surfaces the rare corruption.
				const annotateCorruption = Effect.annotateCurrentSpan({
					'cache.corruption': true,
				});
				const doc = yield* decodeJsonText(CacheEntryDoc, text, {
					source: file,
					mkError: (issue) => issue,
				}).pipe(
					Effect.catch(() => annotateCorruption.pipe(Effect.as(null as CacheEntryDoc | null))),
				);
				if (doc === null) return null;
				return {
					bytes: base64Decode(doc.bytes),
					writtenAt: doc.writtenAt,
				};
			}).pipe(
				Effect.withSpan('substrate.cache.lookup', {
					attributes: {
						namespace: key.namespace,
						chain: key.chain,
						contentHash: key.contentHash,
					},
				}),
			);

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
			}).pipe(
				Effect.withSpan('substrate.cache.write', {
					attributes: {
						namespace: key.namespace,
						chain: key.chain,
						contentHash: key.contentHash,
					},
				}),
			);

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
			}).pipe(
				Effect.withSpan('substrate.cache.delete', {
					attributes: {
						namespace: key.namespace,
						chain: key.chain,
						contentHash: key.contentHash,
					},
				}),
			);

		return CacheService.of({
			lookup,
			write,
			delete: remove,
		});
	}),
);
