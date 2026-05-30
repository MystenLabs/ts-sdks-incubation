import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

/** Allocate a fresh temp directory under `tmpdir()/<prefix>-XXXXXX`,
 *  pass it to `body`, and unconditionally remove it on completion
 *  (success, failure, or interrupt) via an Effect.scoped finalizer.
 *
 *  Modeled on the `withTempHome` pattern in
 *  `test/plugins/seal/source-fetch.test.ts` — promoted to a shared
 *  helper because ~15 test files were independently rolling the same
 *  `mkdtempSync` + try/finally dance, several with leak-on-throw bugs
 *  (no finally) or cleanup-on-Effect-failure gaps. */
export const withTempRoot = <A, E, R>(
	prefix: string,
	body: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), `${prefix}-`))),
		body,
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
	);

/** Sync sibling for tests not running under Effect. Same prefix +
 *  cleanup semantics; the body returns a value and a try/finally
 *  ensures the temp dir is removed even if the body throws. */
export const withTempRootSync = <A>(prefix: string, body: (root: string) => A): A => {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	try {
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

/** Async sibling for vitest tests that aren't running under Effect.
 *  The Promise from `body` is awaited inside the try; cleanup always
 *  runs in `finally`, whether the body resolves or rejects. */
export const withTempRootAsync = async <A>(
	prefix: string,
	body: (root: string) => Promise<A>,
): Promise<A> => {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	try {
		return await body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};
