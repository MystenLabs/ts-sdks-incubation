// Random hex-suffix helper.
//
// Snapshot capture names, codegen cycle ids, and restore staging tags
// all want the same shape: a random hex string of a chosen length,
// derived from `crypto.randomUUID()` so collisions are
// cryptographically negligible across same-process parallel callers
// (the `Math.random()`-based predecessors flagged in STYLE_GUIDE §17
// did NOT have that guarantee).
//
// The choice of length is intentionally a caller knob — different
// surfaces have different staleness windows and collision tolerance:
//
//   - 8 chars: operator-visible names (snapshot id, snap-* prefix).
//             Short enough to type/share.
//   - 12 chars: per-stack container-tag suffixes. Wide enough that
//             two concurrent restores under the same stack don't clash.
//   - 16 chars: codegen cycle ids — transient staging-directory names
//             (`.staging.<id>` / `.bak.<id>`) that the substrate rm's
//             after publish. Defense-in-depth for the race window
//             where two emit cycles under a custom-CLI caller could
//             mint overlapping staging dirs against the same shared
//             outputDir; a collision there would corrupt a half-built
//             tree, not just clash an operator-visible name.
//   - 24 chars: restore staging image tags. Image tags are global to
//             the docker daemon — two parallel restores across stacks
//             share the namespace, so the extra entropy keeps them
//             from clashing under heavy CI parallelism.

import { randomUUID } from 'node:crypto';

/** Mint a random hex suffix of `length` chars. Uses
 *  `crypto.randomUUID()` so collisions are cryptographically
 *  negligible (STYLE_GUIDE §17). `length` is bounded by the UUID's
 *  32 hex chars; callers MUST pass `1..=32`. */
export const mintRandomSuffix = (length: number): string =>
	randomUUID().replace(/-/g, '').slice(0, length);
