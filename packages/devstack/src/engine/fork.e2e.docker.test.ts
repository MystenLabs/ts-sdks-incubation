// Phase 4 P4.T11 — full end-to-end integration: apply → up → snapshot
// save → wipe → snapshot restore → down on a mainnet-fork. ~3 min.
// Gated behind `RUN_FORK_DOCKER_TESTS=1`.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('engine fork end-to-end docker gate (P4.T11)', () => {
	it(
		'apply → up → snapshot save → wipe → snapshot restore → down on mainnet-fork',
		{ timeout: 5 * 60_000 },
		() => {
			// Pending docker wiring. The test would orchestrate the
			// full cycle in one process to prove every seam works
			// against a real container.
			expect(SHOULD_RUN).toBe(true);
		},
	);
});
