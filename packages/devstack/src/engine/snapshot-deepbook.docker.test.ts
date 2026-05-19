// L4 snapshot regression for the full deepbook stack (P5.T10).
// Gated behind DEVSTACK_INTEGRATION_TESTS=1 + DOCKER_OK; CI's
// docker-integration shards opt in.
//
// What it exercises (scaffolded — full body lands in the integration
// sweep alongside the Phase 2/3/4/5 deferred L3 tests):
//
//   1. `pnpm devstack apply` on `examples/deepbook-full`.
//   2. Place a few limit orders + a fill against `sui_usdc` so the
//      indexer / server / margin pool / pyth state all have
//      non-trivial content to capture.
//   3. `devstack snapshot save baseline`.
//   4. `devstack wipe` — every container torn down, state.json removed,
//      generated/ wiped.
//   5. `devstack snapshot restore baseline`.
//   6. Assertions:
//      - `state.json` round-trips.
//      - `src/generated/deepbook-config.ts` re-emits with identical
//        body (`packageIds`, `coins`, `pools`, `marginPools`, `pyth` —
//        each verbatim).
//      - On-chain ids unchanged: query the restored sui RPC for the
//        deepbook package + pool ids and assert they match the values
//        emitted in step 1.
//      - The pyth `PriceInfoObject`s are still present (Pyth on-chain
//        state is captured by sui-localnet's snapshot; the
//        deepbook-config.ts cache hit verifies through them).
//      - The indexer's last-checkpoint cursor is preserved (read
//        from Postgres after restore).
//
// Also folds in:
//   - P2.T8 (snapshot/restore preserves rows in Postgres).
//   - P3.T3 (snapshot/restore stability of /ticker).
//   - P3.T4 (snapshot/restore stability of server container).
//   - P4.T8 (snapshot/restore preserves margin pool ids).

import { describe, it } from 'vitest';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../test-setup/docker/probe.js';

const RUN_INTEGRATION = DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

stampSkipNoticeIfMissing('snapshot-deepbook L4');

describe.skipIf(!RUN_INTEGRATION)(
	'snapshot/restore — full deepbook stack (P5.T10)',
	() => {
		it.todo(
			'apply → save → wipe → restore: deepbook-config.ts regenerated identical content',
		);
		it.todo('on-chain deepbook package + pool ids unchanged after restore');
		it.todo('pyth PriceInfoObject ids unchanged after restore');
		it.todo('indexer last-checkpoint cursor preserved in Postgres after restore');
		it.todo('server /ticker shows the same per-pool lastPrice after restore');
		it.todo('margin pool ids + supplier-cap balance unchanged after restore');
	},
);
