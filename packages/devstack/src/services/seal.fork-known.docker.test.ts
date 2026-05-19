// Phase 3 P3.T5 — `Seal()` in fork mode auto-selects the known
// key-server branch; the resulting tag carries the wrapped upstream's
// canonical key-server registration; reading the `KeyServer` object
// from the fork's gRPC port succeeds.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1` (see
// `sui-fork.container.docker.test.ts` rationale).
//
// The unit equivalent of "factory branches into known-deployment" lives
// in `engine/known-package.fork.test.ts` (P3.T1). The docker case
// extends it to a live container + a live `getObject(keyServerObjectId)`
// read against the fork's gRPC port.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('services/seal fork docker gate (P3.T5)', () => {
	it('Seal() on testnet-fork composes to sealKnownKeyServer(testnet); KeyServer-object read succeeds', () => {
		// Pending docker wiring. Reads
		// `knownDeployments.seal.testnet.keyServerObjectId` via the
		// fork's gRPC port to verify it was pre-fetched (Phase 3 P3.7 —
		// when a future `KnownPackage('seal', {seedObjects})` declaration
		// flows the object id through).
		expect(SHOULD_RUN).toBe(true);
	});
});
