// On-disk shape for one cache entry.
//
// One file per `(namespace, chain, contentHash)` triple, at
// `<runtime-root>/stacks/<stack>/cache/<namespace>/<chain>/<contentHash>.json`.
//
// The entry envelope wraps the bytes (base64-encoded — JSON has no
// binary literal) and the metadata renderer / verify needs. Cache
// callers don't see the envelope; they only see `CacheEntry` from
// `primitives/cache.ts` (bytes + writtenAt).

import { Schema } from 'effect';

import { versionedDocSchema } from '../../versioned-doc-schema.ts';

/** Versioned envelope. Schema-decode failure on read is treated as
 *  a cache MISS (best-effort cache contract — corruption recovers
 *  by re-producing the artifact). */
export const CacheEntryDoc = versionedDocSchema(1, {
	/** Bytes, base64-encoded. Chosen over hex because typical
	 *  artifacts are larger (image manifests, package digests) and
	 *  base64 is 33% overhead vs hex's 100%. */
	bytes: Schema.String,
	/** Unix millis of the write. Renderers may show "produced 5s
	 *  ago"; substrate uses it only for diagnostics. */
	writtenAt: Schema.Number,
	/** Optional namespace-private hint (e.g. "image-tag the cached
	 *  blob refers to"). Substrate stores opaquely. */
	hint: Schema.optional(Schema.String),
});
export type CacheEntryDoc = typeof CacheEntryDoc.Type;
