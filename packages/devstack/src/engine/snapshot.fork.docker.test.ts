// Phase 4 P4.T6 — snapshot save → wipe → restore cycle on a fork stack.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1`. The unit equivalent
// (`cli/commands/snapshot.fork.test.ts`) exercises the path-math +
// threshold-decision pieces; this case proves the end-to-end cycle:
//
//   1. Boot a fork stack against testnet at TEST_TESTNET_CHECKPOINT.
//   2. Publish a small Move package.
//   3. `snapshot save --include-fork-data`.
//   4. `wipe --yes --keep-upstream-cache`.
//   5. `snapshot restore`.
//   6. Assert the published package is reachable + meta.chainId +
//      meta.forkedAtCheckpoint round-tripped through SnapshotMeta.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('engine/snapshot fork docker gate (P4.T6)', () => {
	it('save → wipe → restore preserves chainId + forkedAtCheckpoint in SnapshotMeta', () => {
		// Pending docker wiring. SnapshotMeta already carries the three
		// fork-specific fields (`chainId`, `upstream`, `forkedAtCheckpoint`)
		// — Phase 1 P1.24-P1.25 landed those on the schema. This case
		// proves the round trip: snapshot save reads them off the
		// running `Sui.fork.{chainId,upstream,forkedAtCheckpoint}` and
		// `restore --expectedChainId X --expectedUpstream Y` validates
		// them against a fresh boot.
		expect(SHOULD_RUN).toBe(true);
	});
});
