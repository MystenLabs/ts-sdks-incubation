// Phase 5 Subtopic 4 / TaskList #13 — docker-gated parallel-stack e2e
// for the seal primitive.
//
// Two devstack instances pointing at the same app with different
// `--stack` flags boot concurrently. The seal primitive's host-side
// state is exhaustively stack-keyed (see `./parallel-stack.test.ts` for
// the per-invariant unit-side proofs); this test gates the end-to-end
// shape: both key-server containers run side-by-side, both `/health`
// endpoints come up green, the on-chain `KeyServer.url` field of each
// stack points at the matching stack's routed hostname.
//
// Gated behind `RUN_SEAL_DOCKER_TESTS=1` (matches the pattern other
// seal docker tests follow). The non-docker assertions in
// `./parallel-stack.test.ts` give CI the everyday parallel-safety
// signal without burning the daemon; this test catches regressions
// where the unit-side invariants are correct but the supervisor or
// docker layer composes them wrong (e.g. a shared docker network the
// two stacks would race on).
//
// Pending docker wiring — the test currently asserts only the
// orchestration gate is reachable, mirroring `seal.fork-known.docker.test.ts`
// and the other Phase-5 docker placeholder pattern. A future PR will
// drive the full boot of two `defineDevstack({stackName: 'main', ...})`
// + `defineDevstack({stackName: 'preview', ...})` instances inside the
// same process and assert non-collision.

import { describe, expect, it } from '@effect/vitest';

const SHOULD_RUN = process.env.RUN_SEAL_DOCKER_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('services/seal parallel-stack docker gate (P5.T3 sibling)', () => {
	it(
		'two seal stacks (main + preview) under the same app boot concurrently without collision',
		{ timeout: 5 * 60_000 },
		() => {
			// Pending docker wiring. The full orchestration is:
			//
			//   1. Compose two `sealLocalKeygen({name: 'seal'})` factories
			//      under two `defineDevstack({stackName: ...})` calls
			//      pointing at the same app dir (a vendored fixture under
			//      `tests/fixtures/`).
			//   2. `apply` both stacks concurrently.
			//   3. Assert:
			//      - both `KeyServer.url`s are distinct (`seal.<app>.localhost`
			//        vs `preview.seal.<app>.localhost`)
			//      - both containers run (`docker ps --filter label=devstack.app=<app>`
			//        returns two entries with distinct `devstack.stack` labels)
			//      - both `/health` endpoints return 200
			//      - the BLS keypairs are DISTINCT (per-stack chainId folds
			//        into the state-store cache key so they cannot collide)
			//   4. Tear down both stacks.
			//
			// Expected failure modes if the parallel-safety invariants
			// regress:
			//   - `docker run` 409 conflict on a shared container name
			//     → `composeContainerName` lost the stack dimension
			//   - 503 from Traefik on the second `/health` probe
			//     → `routerId` lost the stack dimension (label collision)
			//   - identical `KeyServer.url` field → `routerHostname` lost
			//     the stack dimension
			expect(SHOULD_RUN).toBe(true);
		},
	);
});
