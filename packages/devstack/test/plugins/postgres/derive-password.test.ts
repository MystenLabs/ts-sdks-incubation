// Regression: `derivePassword(app, stack)` previously sanitized
// `app + stack` together and collided whenever the boundary between
// app and stack was ambiguous after stripping non-alphanumerics. The
// pair `("my-app", "dev")` and `("my", "appdev")` both produced
// `pg-myappdev`, so two parallel stacks on the same host could fight
// over the same Postgres password if their identity strings happened
// to fold the same way.
//
// Fix: a separator + short hash of `(app, stack)` disambiguates the
// boundary. This test pins two known-colliding pairs and verifies
// the derived passwords are now distinct.

import { describe, expect, it } from '@effect/vitest';

import { derivePassword } from '../../../src/plugins/postgres/service.ts';

describe('derivePassword', () => {
	it('disambiguates (app, stack) pairs whose sanitized concatenation collides', () => {
		expect(derivePassword('my-app', 'dev')).not.toBe(derivePassword('my', 'appdev'));
		expect(derivePassword('ab', 'cd')).not.toBe(derivePassword('abc', 'd'));
		expect(derivePassword('my', 'appdev')).not.toBe(derivePassword('my-app', 'dev'));
	});

	it('is deterministic for the same (app, stack)', () => {
		expect(derivePassword('private-content', 'main')).toBe(
			derivePassword('private-content', 'main'),
		);
	});

	it('produces a hash-suffixed identifier matching pg-<body>-<hex8>', () => {
		expect(derivePassword('private-content', 'main')).toMatch(/^pg-[a-zA-Z0-9]+-[0-9a-f]{8}$/);
	});
});
