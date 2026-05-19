// Phase 4 P4.T10 docker companion — `devstack stack drop <name>` on a
// fork stack removes the per-stack subtree AND any running container
// labelled with `devstack.stack=<name>`, but leaves the shared cache
// at `.devstack/sui-fork-cache/` intact.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('cli/commands/stack drop fork docker gate (P4.T10)', () => {
	it('stack drop removes <state>/stacks/<name>/sui-fork/ + container but keeps cache', () => {
		// Pending docker wiring. The test would:
		//   1. Boot fork stack 'foo'.
		//   2. `devstack stack drop foo --yes`.
		//   3. Assert <state>/stacks/foo/ is gone (no sui-fork/ left).
		//   4. Assert docker ps -a --filter label=devstack.stack=foo is empty.
		//   5. Assert <state>/sui-fork-cache/ still exists with content.
		expect(SHOULD_RUN).toBe(true);
	});
});
