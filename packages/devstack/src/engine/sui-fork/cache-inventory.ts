// Read-side inventory of the shared `.devstack/sui-fork-cache/`
// directory. Two callers consume this:
//
//   - `cli/commands/fork.ts:cacheListCommand` / `cachePruneCommand`
//     — `devstack fork cache list` / `prune --unreferenced`.
//   - `cli/commands/prune.ts:maybePruneForkCache` — the
//     `--include-fork-cache` post-pass of cross-stack prune.
//
// Pre-CC-8 these were two separate copies of the same walk under
// `cli/commands/`. They live here now because the work IS engine
// internals (reading per-stack `meta.json` + computing per-entry
// byte counts), with no CLI-specific concerns.

import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { safeDirSize } from '../fs-utils.js';

export interface CacheEntry {
	readonly chainId: string;
	readonly path: string;
	readonly bytes: number;
	readonly referenced: boolean;
}

/**
 * Enumerate per-chainId cache directories under `cacheRoot`. Each
 * entry's `referenced` bit is set when its chainId appears in the
 * supplied `referencedChainIds` set; the upstream literal
 * (`'mainnet'` / `'testnet'`) is also recorded in the set by
 * `collectReferencedChainIds` so older meta.json files that didn't
 * persist `chainId` still match.
 */
export const collectCacheEntries = async (
	cacheRoot: string,
	referencedChainIds: ReadonlySet<string>,
): Promise<ReadonlyArray<CacheEntry>> => {
	let entries: ReadonlyArray<string>;
	try {
		entries = await nodeFs.readdir(cacheRoot);
	} catch {
		return [];
	}
	const out: Array<CacheEntry> = [];
	for (const entry of entries) {
		const full = joinPath(cacheRoot, entry);
		const stat = await nodeFs.stat(full).catch(() => undefined);
		if (stat === undefined || !stat.isDirectory()) continue;
		const bytes = await safeDirSize(full);
		out.push({
			chainId: entry,
			path: full,
			bytes,
			referenced: referencedChainIds.has(entry),
		});
	}
	return out;
};

/**
 * Walk every per-stack `meta.json` under `<stateRoot>/stacks/*\/sui-fork/`
 * collecting the set of referenced chain ids. For now we also fold the
 * meta's `upstream` literal in as a fallback because cache directories
 * keyed by `'mainnet'` should be treated as referenced even when
 * `chainId` wasn't recorded (pre-P4.T4 meta.json files).
 *
 * Best-effort throughout: an unreadable meta.json or a missing stacks
 * dir contributes nothing rather than aborting the walk.
 */
export const collectReferencedChainIds = async (
	stateRoot: string,
): Promise<ReadonlySet<string>> => {
	const stacksDir = joinPath(stateRoot, 'stacks');
	const out = new Set<string>();
	let stacks: ReadonlyArray<string>;
	try {
		stacks = await nodeFs.readdir(stacksDir);
	} catch {
		return out;
	}
	for (const stack of stacks) {
		const metaPath = joinPath(stacksDir, stack, 'sui-fork', 'meta.json');
		try {
			const raw = await nodeFs.readFile(metaPath, 'utf8');
			const parsed = JSON.parse(raw) as {
				upstream?: string;
				chainId?: string;
			};
			if (parsed.chainId !== undefined) out.add(parsed.chainId);
			// Also fold the upstream name in as a fallback so a cache
			// dir keyed by `'mainnet'` is treated as referenced even
			// when chainId wasn't recorded.
			if (parsed.upstream !== undefined) out.add(parsed.upstream);
		} catch {
			// best-effort
		}
	}
	return out;
};
