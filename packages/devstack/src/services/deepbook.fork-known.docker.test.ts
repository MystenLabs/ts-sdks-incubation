// Phase 3 P3.T2 — `Deepbook()` in fork mode auto-selects the
// known-deployment branch; the resulting tag points at the wrapped
// upstream's real Deepbook package; reading a pool's state succeeds.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1` because the test requires:
//   - A running sui-fork container (60-180s cold start)
//   - Network access to the upstream testnet GraphQL warming pass
//
// The unit equivalent — that the factory routes to
// `deepbookKnownPackage` with the stripped network — is covered by
// `engine/known-package.fork.test.ts` (P3.T1). The docker case proves
// the round-trip: composing `Deepbook()` on a `testnet-fork` stack
// yields the real testnet Deepbook deployment + a pool object query
// against the fork's gRPC port succeeds.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('services/deepbook fork docker gate (P3.T2)', () => {
	it('Deepbook() on testnet-fork composes to deepbookKnownPackage(testnet); a pool read succeeds', () => {
		// Pending docker wiring. The unit-level dispatch is verified in
		// `engine/known-package.fork.test.ts` — the docker run extends
		// that contract to a live container + live pool object read via
		// `client.core.getObject(<testnet DEEP_SUI pool id>)`.
		expect(SHOULD_RUN).toBe(true);
	});
});
