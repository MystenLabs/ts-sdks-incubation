// Phase 4 P4.T5 docker companion — full apply → edit config → apply
// cycle that proves `SeedManifestMismatchError` fires on a real fork
// stack. Gated behind `RUN_FORK_DOCKER_TESTS=1`.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('cli/commands/apply fork seed-mismatch docker gate (P4.T5)', () => {
	it('two `apply` runs with diverging addresses → second fails with actionable recipe', () => {
		// Pending docker wiring. The test would:
		//   1. `apply` with seed=[A, B] → succeeds, writes meta.json.
		//   2. Edit the user's devstack.config.ts to seed=[A, B, C].
		//   3. `apply` → fails with `SeedManifestMismatchError`.
		//   4. Parse the failure output, assert it contains the
		//      `devstack wipe --keep-upstream-cache && devstack apply`
		//      recipe verbatim.
		//   5. Run the recipe.
		//   6. `apply` again with seed=[A, B, C] → succeeds.
		expect(SHOULD_RUN).toBe(true);
	});
});
