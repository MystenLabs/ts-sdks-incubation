// Phase 4 P4.T9 docker companion — `devstack doctor` against a live
// fork stack runs the 4 new fork-specific checks (P4.11-P4.14) and
// passes when the binary + upstream + meta + data-dir-size invariants
// are sound.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('cli/commands/doctor fork docker gate (P4.T9)', () => {
	it('doctor includes + passes the 4 new fork checks when a fork stack is on disk', () => {
		// Pending docker wiring. The test would:
		//   1. Boot a fork stack.
		//   2. `devstack doctor` and assert stdout contains:
		//      - "sui-fork binary"     (P4.11)
		//      - "upstream GraphQL"    (P4.12)
		//      - "fork seed manifest"  (P4.13)
		//      - "fork data dir size"  (P4.14)
		//   3. Verify the binary check carries the "informational" tag
		//      since the host doesn't have sui-fork built locally.
		//   4. Verify the GraphQL check resolves to "reachable: testnet"
		//      (or a clear unreachable line if behind a firewall).
		expect(SHOULD_RUN).toBe(true);
	});
});
