// Subpath-export contract: `@mysten-incubation/devstack/vitest` re-exports
// from `@effect/vitest`, so consumers of the subpath need `@effect/vitest`
// resolvable in their node_modules tree. Without a peerDependency entry,
// pnpm hoist + npm dedup don't guarantee that — the import would fail at
// runtime with `Cannot find package '@effect/vitest'`. Lock it as an
// optional peer (consumers who don't import the /vitest subpath shouldn't
// be forced to install it).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe('vitest subpath peer dependency contract', () => {
	it('declares @effect/vitest as an optional peer', () => {
		expect(pkg.peerDependencies?.['@effect/vitest']).toBeDefined();
		expect(pkg.peerDependenciesMeta?.['@effect/vitest']?.optional).toBe(true);
	});
});
