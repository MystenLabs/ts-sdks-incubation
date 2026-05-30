// Shared stable content-hash helper for the DeepBook plugin family.
//
// `deploy.ts` (pools + seed cache keys) and `pyth/index.ts` (feed cache
// key) both derive an `ArtifactPublisher` content hash from a canonical
// `||`-joined input string. Both used the identical sha256 → branded
// `ContentHash` derivation; this module is the single definition both
// import so the brand stays consistent across the DeepBook artifacts.

import { createHash } from 'node:crypto';

import { contentHash as brandContentHash, type ContentHash } from '../../substrate/brand.ts';

/** sha256 the canonical input string and brand it as a `ContentHash`. */
export const stableContentHash = (input: string): ContentHash =>
	brandContentHash(createHash('sha256').update(input).digest('hex'));
