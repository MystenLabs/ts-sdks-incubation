// Universal content-addressed cache primitive.
//
// Architecture § Cache data model: `(namespace, chainId, content-hash)`
// keys; lookup / write / GC. Cache entries can be dropped at will;
// state-store entries are durable.
//
// This is L0 substrate — no service names. Plugins choose their own
// `namespace`; substrate folds chainId in.

import type { Effect } from 'effect';

import type { ChainId, ContentHash } from '../substrate/brand.ts';

/** Cache key components. The substrate computes the on-disk key
 *  from these — plugins never construct path strings. */
export interface CacheKey {
	readonly namespace: string;
	readonly chain: ChainId;
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
}

export interface CacheError {
	readonly _tag: 'CacheError';
	readonly reason: 'io-failed' | 'corruption' | 'lock-contention';
	readonly detail: string;
}
