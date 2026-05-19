// Engine-wide content-hash helper. Unifies the half-dozen ad-hoc
// `crypto.createHash('sha256').update(...).digest('hex').slice(0, N)`
// open-codings into one signature with a documented `length` knob.
//
// Why centralize:
//   - The hex-slice length matters for cache-key collision resistance
//     (longer = safer; shorter = nicer container tags). Keeping the
//     knob in one place documents the convention rather than burying
//     it as a magic 12/16/24/full in each call site.
//   - Object inputs flow through `JSON.stringify` with the same
//     replacer-or-no-replacer convention — every caller previously had
//     to remember to canonicalize sort order itself (the loop body
//     of every pyth/deepbook/walrus `hashFoo` helper). The unified
//     entry point keeps that contract obvious: the caller is
//     responsible for canonicalizing (sorting, normalizing) the input
//     BEFORE handing it over, the helper just hashes.
//   - The streaming variant (`createContentHasher`) lets callers that
//     accumulate state across many `.update()` calls (tree walks,
//     mtime+name+path fingerprints) share the same algorithm so a
//     future algorithm swap touches one file.
//
// Algorithm: sha256. Output: lowercase hex. Default truncation: full
// (64 chars). Callers that want short tags pass `{length: 12}` (the
// content-addressed docker tag convention) or `{length: 16}` (the
// config-hash convention for cache keys).

import { createHash, type Hash } from 'node:crypto';

/** Optional knobs for {@link contentHash}. */
export interface ContentHashOptions {
	/** Hex digest truncation length (number of chars). Default: 64 (full
	 *  sha256). Common settings:
	 *    - `12` — content-addressed docker image tags (`devstack-foo:abc123def456`).
	 *    - `16` — config-hash cache keys (deepbook pools, pyth feeds, fork meta).
	 *    - `24` — codegen bindings fingerprint (collision-resistance over many
	 *             targets in a single run).
	 *    - `64` — full digest (file content fingerprints; supervisor watcher). */
	readonly length?: number;
}

/** Compute a sha256 content hash of `input`, hex-encoded and truncated
 *  to `options.length` (default: full 64 chars).
 *
 *  Accepted input shapes:
 *    - `string` — hashed as UTF-8 bytes.
 *    - `Uint8Array` (incl. `Buffer`) — hashed verbatim.
 *    - `object` — serialized via `JSON.stringify(input)` and hashed as
 *      UTF-8. Callers MUST canonicalize (sort keys / normalize bigints)
 *      before passing in — `JSON.stringify` does NOT sort object keys.
 *
 *  For multi-input streaming (tree walks, mtime+path fingerprints) use
 *  {@link createContentHasher}. */
export const contentHash = (
	input: string | Uint8Array | object,
	options?: ContentHashOptions,
): string => {
	const hasher = createHash('sha256');
	if (typeof input === 'string') {
		hasher.update(input);
	} else if (input instanceof Uint8Array) {
		hasher.update(input);
	} else {
		hasher.update(JSON.stringify(input));
	}
	const hex = hasher.digest('hex');
	const length = options?.length;
	return length === undefined ? hex : hex.slice(0, length);
};

/** Open a fresh sha256 streaming hasher. Caller drives `.update(...)`
 *  calls themselves; finalize with `.digest('hex')` then truncate via
 *  {@link truncateDigest} (or call `digestHex` for a one-shot finalize).
 *
 *  Used by tree-walk fingerprints (`hashLocalTree` in
 *  `advanced/plugin-author/docker-image.ts`, `hashMoveSources` in
 *  `services/package/internal.ts`) and by emit fingerprints
 *  (`computeFingerprint` in `codegen/emitters/bindings.ts`). */
export const createContentHasher = (): Hash => createHash('sha256');

/** Truncate a full hex digest to `length` chars. Mirrors the slice
 *  convention used by {@link contentHash} so streaming callers stay
 *  consistent with one-shot callers. */
export const truncateDigest = (hex: string, length: number): string => hex.slice(0, length);

/** Finalize a streaming hasher to a hex digest, optionally truncated to
 *  `length` chars. Convenience that pairs with {@link createContentHasher}. */
export const digestHex = (hasher: Hash, options?: ContentHashOptions): string => {
	const hex = hasher.digest('hex');
	const length = options?.length;
	return length === undefined ? hex : hex.slice(0, length);
};
