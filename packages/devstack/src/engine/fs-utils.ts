// Tiny filesystem helpers used across the CLI surface. Kept as
// plain `Promise`-returning functions (not Effect) because every
// callsite is already inside `Effect.promise(() => …)` or `await`-
// style code, and a sync `try/catch` is easier to reason about
// than an Effect that needs to swallow "missing path" silently.

import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';

/**
 * Recursively sum the size in bytes of `root`. Returns `0` for
 * missing paths, stat failures, or empty directories. Used by:
 *
 *   - `cli/commands/snapshot.ts` — auto-include threshold for the
 *     per-stack `sui-fork/data/` extras.
 *   - `cli/commands/doctor.ts` — Inventory section's fork data dir
 *     size column.
 *   - `engine/sui-fork/cache-inventory.ts` — per-chainId byte
 *     counts in the shared `.devstack/sui-fork-cache/`.
 *
 * Best-effort by design: a permission error or a race against
 * `rm -rf` collapses to `0` so the caller surfaces "size unknown"
 * rather than aborting the surrounding command.
 */
export const safeDirSize = async (root: string): Promise<number> => {
	try {
		const stat = await nodeFs.stat(root);
		if (stat.isDirectory()) {
			let total = 0;
			const entries = await nodeFs.readdir(root);
			for (const entry of entries) {
				total += await safeDirSize(joinPath(root, entry));
			}
			return total;
		}
		return stat.size;
	} catch {
		return 0;
	}
};
