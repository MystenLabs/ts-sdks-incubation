// Universal content-addressed cache primitive.
//
// Architecture § Cache data model: `(namespace, chain, content-hash)`
// keys; lookup / write / GC. Cache entries can be dropped at will;
// state-store entries are durable.
//
// This is L0 substrate — no service names. Plugins choose their own
// `namespace`; `chain` is a plain string key forwarded verbatim.

import type { Effect, Scope } from 'effect';

import type { ArtifactPublishError, ArtifactSpec } from './artifact-publisher.ts';
import type { ContentHash } from '../substrate/brand.ts';

/** Cache key components. The substrate computes the on-disk key
 *  from these — plugins never construct path strings. The `chain` is a
 *  plain string value supplied by the caller; the substrate keys on it
 *  verbatim (preserving warm-restart id stability). */
export interface CacheKey {
	readonly namespace: string;
	readonly chain: string;
	readonly contentHash: ContentHash;
}

/** A cache hit returns the stored bytes plus the time it was
 *  written. */
export interface CacheEntry {
	readonly bytes: Uint8Array;
	readonly writtenAt: number;
}

/** The cache service. */
export interface Cache {
	readonly lookup: (key: CacheKey) => Effect.Effect<CacheEntry | null, CacheError>;
	readonly write: (key: CacheKey, bytes: Uint8Array) => Effect.Effect<void, CacheError>;
	readonly delete: (key: CacheKey) => Effect.Effect<void, CacheError>;
	/** Orchestrate the `cache → verify → produce → register` cycle for an
	 *  `ArtifactSpec` (architecture §10). Folds the former `ArtifactPublisher`
	 *  facade in: identical signature to `ArtifactPublisher['publish']`, so the
	 *  cache structurally satisfies that contract. Forwards the plugin-supplied
	 *  HEX `spec.chain` VERBATIM into the cache key — never folds
	 *  `identity.chain` — preserving warm-restart id stability. */
	readonly publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	) => Effect.Effect<Produced, ArtifactPublishError, Scope.Scope>;
}

export interface CacheError {
	readonly _tag: 'CacheError';
	readonly reason: 'io-failed' | 'corruption' | 'lock-contention';
	readonly detail: string;
}
