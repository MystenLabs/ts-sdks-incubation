// The lifecycle-prune group key is a display-only string handle for a
// `(app, stack)` tuple. It uses `/` as a human-readable separator
// (`arena/main`) so log/JSON output stays operator-friendly. Internal
// grouping is structural via `GroupBuckets` (a nested `app → stack`
// map), so a `/` inside `app` or `stack` cannot produce a wrong tuple
// at the membership-test boundary — callers compare keys produced by
// the same constructor, they never re-split the string. The
// theoretical `'foo/bar' + 'main'` vs `'foo' + 'bar/main'` collision
// is accepted because Docker label values containing `/` in the `app`
// / `stack` slot are not produced by any first-party caller, and the
// structural map remains correct either way.
//
// This test pins the shape of the key so any regression to a
// non-`/`-joined form (which would break log/JSON consumers like the
// `prune --list` CLI assertion in `surfaces/cli/dispatch.test.ts`) is
// caught early.

import { describe, expect, it } from 'vitest';

import { lifecyclePruneGroupKey } from '../../../src/orchestrators/lifecycle-prune/index.ts';

describe('lifecyclePruneGroupKey — human-readable shape', () => {
	it('produces `<app>/<stack>`', () => {
		expect(lifecyclePruneGroupKey('arena', 'main')).toBe('arena/main');
		expect(lifecyclePruneGroupKey('wallet', 'main')).toBe('wallet/main');
		expect(lifecyclePruneGroupKey('arena', 'staging')).toBe('arena/staging');
	});

	it('distinct (app, stack) tuples produce distinct keys', () => {
		const a = lifecyclePruneGroupKey('arena', 'main');
		const b = lifecyclePruneGroupKey('wallet', 'main');
		const c = lifecyclePruneGroupKey('arena', 'staging');
		expect(new Set([a, b, c]).size).toBe(3);
	});
});
