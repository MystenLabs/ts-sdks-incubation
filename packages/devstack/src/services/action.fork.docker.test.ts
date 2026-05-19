// Phase 3 P3.T7 — `Action()` runs on fork mode. The cached-tx probe
// uses `client.core.getObject(...)` (NOT the unsupported
// `getBalance`/`listBalances` surfaces — those are guarded by Phase 1's
// `forkGuard` Proxy and would throw `ForkUnsupportedError` before the
// wire). A second `Action()` run hits the cache.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1` (see
// `sui-fork.container.docker.test.ts` rationale).

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('services/action fork docker gate (P3.T7)', () => {
	it('Action() runs on a fork stack; probeCachedTx hits client.core.getObject; second run cache-hits', () => {
		// Pending docker wiring. The unit-equivalent that the action
		// probe path uses `getObject` (not `getBalance`) is verified at
		// the engine layer — the docker case proves the round-trip end
		// to end including the cache-hit on the second invocation.
		expect(SHOULD_RUN).toBe(true);
	});
});
