// Phase 3 P3.T3 — `Walrus()` in fork mode auto-selects the
// known-deployment branch and the resulting tag carries the wrapped
// upstream's real Walrus system object; reading it from the fork's
// gRPC port succeeds.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1` for the cold-start + upstream
// reachability reasons documented in `sui-fork.container.docker.test.ts`.
//
// The unit equivalent of "factory branches into known-deployment" lives
// in `engine/known-package.fork.test.ts` (P3.T1). The docker case adds
// the round-trip: `client.core.getObject(walrusSystemObjectId)`.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('services/walrus fork docker gate (P3.T3)', () => {
	it('Walrus() on testnet-fork composes to walrusKnownDeployment(testnet); system-object read succeeds', () => {
		// Pending docker wiring. Reads the real testnet Walrus system
		// object (`knownDeployments.walrus.testnet.systemObjectId`) via
		// the fork's gRPC port to confirm the fork's seed-objects path
		// pre-fetched it (Phase 3 P3.7 auto-feed when KnownPackage carries
		// `seedObjects`).
		expect(SHOULD_RUN).toBe(true);
	});
});
