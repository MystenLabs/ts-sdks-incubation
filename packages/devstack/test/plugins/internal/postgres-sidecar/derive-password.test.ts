import { describe, expect, it } from '@effect/vitest';

import { deriveSidecarPassword } from '../../../../src/plugins/internal/postgres-sidecar/service.ts';

// A sibling-owned sidecar's PGDATA rides the OWNER's snapshot and restored
// image layers. Its password must stay invariant across runtime roots for the
// same `(app, stack, role)` tuple, or a restored PGDATA stops authenticating.
describe('deriveSidecarPassword', () => {
	const ROLE = 'indexer-db';

	it('is invariant for the same app, stack, and sidecar role', () => {
		expect(deriveSidecarPassword('myapp', 'main', ROLE)).toBe(
			deriveSidecarPassword('myapp', 'main', ROLE),
		);
	});

	it('distinguishes two sidecar roles of the same stack', () => {
		expect(deriveSidecarPassword('myapp', 'main', 'indexer-db')).not.toBe(
			deriveSidecarPassword('myapp', 'main', 'events-db'),
		);
	});

	it('disambiguates tuples whose sanitized concat collides', () => {
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
