// L3 real-Docker tests for `deepbookMargin(opts)` and
// `deepbookMarginSeed(opts)`. Gated behind the integration-tests env
// var so `pnpm test` stays fast on a cold cache.
//
// Test cases (Phase 4 plan):
//   P4.T3 — margin publish captures registry + admin cap. Assert
//            state.json `publishMove/margin.publish` has
//            `captured.registryId` + `captured.adminCapId`, both
//            0x-prefixed and on-chain.
//   P4.T4 — margin pools created per asset. Assert state.json carries
//            two `margin/margin-pools/v1/...` entries; each pool
//            object's type contains `::margin_pool::MarginPool<...>`
//            with the correct generic.
//   P4.T6 — margin seed supply tx lands; decode the captured
//            `MarginPool` object's `total_supply` via getObject + bcs
//            decoder; assert >= seed amount (after scalar).
//   P4.T7 — idempotent re-apply: state.json packageId + marginPools
//            unchanged; second apply shows `cache hit`.
//   P4.T8 — engine/snapshot-deepbook.docker.test.ts extended to
//            include margin in the fixture. Assert margin pool ids
//            identical pre/post snapshot. (Folds into the Phase 5
//            integration-sweep snapshot regression.)
//   P4.T9 — indexer pickup: with margin in the stack, indexer's
//            MARGIN_PACKAGES env reflects the deployed packageId;
//            place a margin-related event; verify it lands in
//            Postgres.

import { describe, it } from 'vitest';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../../test-setup/docker/probe.js';

const RUN_INTEGRATION =
	DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

stampSkipNoticeIfMissing('deepbookMargin L3 docker');

describe.skipIf(!RUN_INTEGRATION)('deepbookMargin — real-Docker fixture', () => {
	// P4.T3 — margin publish surfaces MarginRegistry + MarginAdminCap.
	it.todo('publish captures MarginRegistry + MarginAdminCap as 0x-prefixed ids');
	// P4.T4 — per-asset MarginPool<T> created with correct generic.
	it.todo('creates one MarginPool<T> per asset with the correct generic in objectType');
	// P4.T6 — seed supply lands with total_supply >= seed amount.
	it.todo('margin seed: total_supply >= seed amount after supply tx');
	// P4.T7 — idempotent re-apply hits cache.
	it.todo('re-apply uses cached margin pools (cache hit)');
	// P4.T8 — snapshot/restore: ids unchanged.
	it.todo('snapshot/restore preserves margin pool ids');
	// P4.T9 — indexer MARGIN_PACKAGES env is set.
	it.todo('indexer with margin Ref carries MARGIN_PACKAGES env var');
});
