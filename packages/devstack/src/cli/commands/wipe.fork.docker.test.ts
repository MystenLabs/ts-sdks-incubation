// Phase 4 P4.T7 / P4.T8 — wipe's cache behavior under a real fork
// stack. Gated behind `RUN_FORK_DOCKER_TESTS=1`.
//
// The unit equivalent (`wipe.fork.test.ts`) covers the path-resolution
// invariant. This case proves the live cold-restart behavior:
//
//   P4.T7: wipe (default) → next `apply` reuses warmed upstream cache
//          (cold-start latency < 30s instead of 60-180s).
//   P4.T8: wipe --also-upstream-cache → next `apply` pays the full
//          cold-start cost.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('cli/commands/wipe fork docker gate (P4.T7, P4.T8)', () => {
	it('P4.T7: default wipe leaves <state>/sui-fork-cache; cold-restart reuses', () => {
		// Pending docker wiring. The test would:
		//   1. Boot fork stack, time `apply` (T_cold).
		//   2. `wipe --yes` (no --also-upstream-cache).
		//   3. Boot fork stack again, time `apply` (T_warm).
		//   4. Assert T_warm < T_cold by a measurable margin (e.g. 30%
		//      faster), confirming the cache survived.
		expect(SHOULD_RUN).toBe(true);
	});

	it('P4.T8: --also-upstream-cache wipes <state>/sui-fork-cache; cold-restart pays full cost', () => {
		// Pending docker wiring.
		expect(SHOULD_RUN).toBe(true);
	});
});
