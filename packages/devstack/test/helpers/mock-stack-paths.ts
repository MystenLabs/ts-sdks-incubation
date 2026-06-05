// Shared `StackPaths` mock for tests that need a `StackPathsService`
// layer rooted at a temp directory.
//
// Extracted from the copy-pasted `stackPathsFor`/`stackPathsLayer` pair
// that previously lived in lock.test.ts + several runtime/docker tests.
// The cross-process lock + roster files derive from `stackRoot` by
// default; the optional `rosterBase` parameter redirects the
// lock/roster pair elsewhere.

import { join } from 'node:path';

import { Layer } from 'effect';

import { StackPathsService, type StackPaths } from '../../src/substrate/runtime/paths.ts';

/**
 * Build a `StackPaths` value rooted at `stackRoot`. When `rosterBase`
 * is supplied, the stack-lock / roster files are placed under it
 * instead of `stackRoot`.
 */
export const stackPathsFor = (stackRoot: string, rosterBase: string = stackRoot): StackPaths => {
	const cacheDir = join(stackRoot, 'cache');
	const cacheNamespaceDir = (namespace: string): string => join(cacheDir, namespace);
	const cacheChainDir = (namespace: string, chain: string): string =>
		join(cacheNamespaceDir(namespace), chain);
	const cacheEntry = (
		namespace: string,
		chain: string,
		contentHash: string,
	): { readonly dir: string; readonly file: string } => {
		const dir = cacheChainDir(namespace, chain);
		return { dir, file: join(dir, `${contentHash}.json`) };
	};
	return {
		stackRoot,
		cacheDir,
		snapshotDir: join(stackRoot, 'snapshots'),
		stackLockFile: join(rosterBase, 'stack.lock'),
		rosterFile: join(rosterBase, 'roster.json'),
		cacheEntry,
		cacheChainDir,
		cacheNamespaceDir,
	};
};

/** `Layer.succeed`-wrapped `stackPathsFor`. */
export const stackPathsLayer = (
	stackRoot: string,
	rosterBase: string = stackRoot,
): Layer.Layer<StackPathsService> =>
	Layer.succeed(StackPathsService)(stackPathsFor(stackRoot, rosterBase));
