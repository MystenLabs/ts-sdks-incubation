// L3 real-Docker tests for `deepbookMarginSeed(opts)`. Mirrors the
// gate convention of `margin.docker.test.ts` — DEVSTACK_INTEGRATION_TESTS=1
// + DOCKER_OK at suite load.
//
// Test cases (Phase 4 plan):
//   P4.T6 — supply tx lands; verify the captured SupplierCap object
//            exists on chain and the MarginPool's `total_supply` is
//            >= the seed amount (after scalar).

import { describe, it } from 'vitest';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../../test-setup/docker/probe.js';

const RUN_INTEGRATION =
	DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

stampSkipNoticeIfMissing('deepbookMarginSeed L3 docker');

describe.skipIf(!RUN_INTEGRATION)('deepbookMarginSeed — real-Docker fixture', () => {
	it.todo('mints SupplierCap + supplies per-asset seed; total_supply >= seed amount');
});
