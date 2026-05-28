// Regression for Phase B3: the lifecycle-prune group key (a display-only
// string handle) used to be `${app}/${stack}`. With a forward-slash
// inside `app` OR `stack`, two distinct `(app, stack)` tuples could
// collide on the string round-trip. The fix swaps to ASCII unit
// separator (`\x1F`) — excluded from valid Docker label values — and
// uses a structural `{app, stack}` map (`GroupBuckets`) for internal
// grouping. Test the public symptom: distinct `(app, stack)` tuples
// produce distinct group keys, even when one side contains `/`.

import { describe, expect, it } from 'vitest';

import { lifecyclePruneGroupKey } from '../../../src/orchestrators/lifecycle-prune/index.ts';

describe('lifecyclePruneGroupKey — slash safety', () => {
	it('distinct (app, stack) tuples produce distinct keys', () => {
		const a = lifecyclePruneGroupKey('arena', 'main');
		const b = lifecyclePruneGroupKey('wallet', 'main');
		const c = lifecyclePruneGroupKey('arena', 'staging');
		expect(new Set([a, b, c]).size).toBe(3);
	});

	it('app containing `/` does not collide with the equivalent split via stack', () => {
		// Pre-fix collision: `${'foo/bar'}/${'main'}` === `${'foo'}/${'bar/main'}`
		// (both stringify to `'foo/bar/main'`).
		const slashInApp = lifecyclePruneGroupKey('foo/bar', 'main');
		const slashInStack = lifecyclePruneGroupKey('foo', 'bar/main');
		expect(slashInApp).not.toBe(slashInStack);
	});

	it('stack containing `/` does not collide with the equivalent split via app', () => {
		const a = lifecyclePruneGroupKey('app', 'with/slash/stack');
		const b = lifecyclePruneGroupKey('app/with', 'slash/stack');
		const c = lifecyclePruneGroupKey('app/with/slash', 'stack');
		expect(new Set([a, b, c]).size).toBe(3);
	});

	it('separator is NOT a forward slash (which can appear in app/stack)', () => {
		// The exact separator character is an implementation detail; what
		// matters is that the key cannot be confused with a `/`-joined
		// pair. Asserting the separator is non-`/` is sufficient to lock
		// in the fix and would catch a regression to `${app}/${stack}`.
		const key = lifecyclePruneGroupKey('app', 'stack');
		expect(key).toContain('app');
		expect(key).toContain('stack');
		expect(key.split('/').length).toBe(1);
	});
});
