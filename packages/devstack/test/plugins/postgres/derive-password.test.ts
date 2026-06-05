// Regression: `derivePassword(app, stack, stackRoot)` previously
// sanitized `app + stack` together and collided whenever the boundary
// between app and stack was ambiguous after stripping non-
// alphanumerics. The pair `("my-app", "dev")` and `("my", "appdev")`
// both produced `pg-myappdev`, so two parallel stacks on the same host
// could fight over the same Postgres password if their identity
// strings happened to fold the same way.
//
// Fix: a separator + short hash of `(app, stack, stackRoot)`
// disambiguates the boundary. `stackRoot` (the on-disk runtime root
// for this checkout) folds in so two checkouts of the same
// `(app, stack)` on the same machine derive distinct passwords — a
// container started for one checkout cannot be picked up by the
// other's `pg_isready` probe under the right credentials.

import { describe, expect, it } from '@effect/vitest';

import { derivePassword, deriveSidecarPassword } from '../../../src/plugins/postgres/service.ts';

const ROOT_A = '/Users/dev/projects/myproject/.devstack/myapp/main';
const ROOT_B = '/Users/dev/projects/other-checkout/.devstack/myapp/main';

describe('derivePassword', () => {
	it('disambiguates (app, stack) pairs whose sanitized concatenation collides', () => {
		expect(derivePassword('my-app', 'dev', ROOT_A)).not.toBe(
			derivePassword('my', 'appdev', ROOT_A),
		);
		expect(derivePassword('ab', 'cd', ROOT_A)).not.toBe(derivePassword('abc', 'd', ROOT_A));
		expect(derivePassword('my', 'appdev', ROOT_A)).not.toBe(
			derivePassword('my-app', 'dev', ROOT_A),
		);
	});

	it('disambiguates two checkouts of the same (app, stack) on different stackRoots', () => {
		expect(derivePassword('myapp', 'main', ROOT_A)).not.toBe(
			derivePassword('myapp', 'main', ROOT_B),
		);
	});

	it('is deterministic for the same (app, stack, stackRoot)', () => {
		expect(derivePassword('private-content', 'main', ROOT_A)).toBe(
			derivePassword('private-content', 'main', ROOT_A),
		);
	});

	it('produces a hash-suffixed identifier matching pg-<body>-<hex8>', () => {
		expect(derivePassword('private-content', 'main', ROOT_A)).toMatch(
			/^pg-[a-zA-Z0-9]+-[0-9a-f]{8}$/,
		);
	});
});

// Regression (sui-tools indexer-db sidecar): a sibling-owned sidecar's PGDATA
// rides the OWNER's snapshot and its committed layer is aliased onto the
// content-addressed `devstack-build:*` build tag, which a later boot reuses
// (on-host tag-exists short-circuit). So the sidecar password — baked into
// PGDATA at first init, never re-applied on reuse/restore — MUST be invariant
// across runs of the same `(app, stack)`, regardless of the (per-run) runtime
// root. `deriveSidecarPassword` therefore drops `stackRoot`; a `stackRoot`-
// folded credential churned per e2e run and stopped matching the persisted
// PGDATA → `FATAL: password authentication failed`, crash-looping the
// validator's embedded indexer (the snapshot-restore matrix e2e symptom).
describe('deriveSidecarPassword', () => {
	const ROLE = 'indexer-db';

	it('is INVARIANT across stackRoots (so a reused/restored PGDATA still authenticates)', () => {
		// The crux: unlike `derivePassword`, the sidecar password must NOT depend
		// on the runtime root, since its persisted PGDATA outlives any one root.
		expect(deriveSidecarPassword('myapp', 'main', ROLE)).toBe(
			deriveSidecarPassword('myapp', 'main', ROLE),
		);
	});

	it('distinguishes two sidecar roles of the same stack', () => {
		expect(deriveSidecarPassword('myapp', 'main', 'indexer-db')).not.toBe(
			deriveSidecarPassword('myapp', 'main', 'events-db'),
		);
	});

	it('disambiguates (app, stack, role) tuples whose sanitized concat collides', () => {
		expect(deriveSidecarPassword('my-app', 'dev', ROLE)).not.toBe(
			deriveSidecarPassword('my', 'appdev', ROLE),
		);
	});

	it('produces a hash-suffixed identifier matching pg-<body>-<hex8>', () => {
		expect(deriveSidecarPassword('private-content', 'main', ROLE)).toMatch(
			/^pg-[a-zA-Z0-9]+-[0-9a-f]{8}$/,
		);
	});
});
