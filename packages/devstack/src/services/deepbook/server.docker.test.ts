// L3 real-Docker tests for `DeepbookServer(opts)`. Gated behind the
// integration-tests env var so `pnpm test` stays fast on a cold cache;
// CI's docker-integration shards opt in.
//
// Test cases (Phase 3 plan):
//   P3.T1 — full stack + DeepbookServer; place 3 orders + 1 fill;
//            `curl ${server.rest}/ticker`; assert 200 + JSON with
//            `sui_usdc` row carrying numeric lastPrice + bestBid + bestAsk.
//   P3.T2 — snapshot/restore roundtrip stability of /ticker response.
//   P3.T4 — multi-stack regression: two concurrent stacks both expose
//            their own DeepbookServer; verify ports allocate cleanly
//            (no EADDRINUSE); each queries its own Postgres.
//
// P3.T3 (L4) folds into `engine/snapshot-deepbook.docker.test.ts` —
// that file is added once the Phase-5 integration-sweep lands (see
// the plan's "Phase 2 status / deferred to Phase 5" note).
//
// Scaffolded with the same gate convention as other L3 tests in this
// package: probe DOCKER_OK and DEVSTACK_INTEGRATION_TESTS=1 at suite
// load. The container-side behavior (REST API responses, snapshot
// hooks) needs the real indexer + server images + a vendored
// deepbook-v3 Move source, so we drop in a no-op test that asserts
// the integration is wired and defer the heavy lift to the sweep.

import { describe, it } from 'vitest';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../../test-setup/docker/probe.js';

const RUN_INTEGRATION = DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

stampSkipNoticeIfMissing('DeepbookServer L3 docker');

describe.skipIf(!RUN_INTEGRATION)('DeepbookServer — real-Docker fixture', () => {
	// P3.T1 — REST `/ticker` 200 + numeric lastPrice/bestBid/bestAsk.
	it.todo('serves /ticker with numeric lastPrice/bestBid/bestAsk after 3 orders + 1 fill');
	// P3.T2 — snapshot/restore stability: /ticker per-pool lastPrice
	//          unchanged across save → wipe → restore.
	it.todo('survives snapshot/restore with unchanged per-pool lastPrice');
	// P3.T4 — concurrent-stack: two stacks each with their own
	//          DeepbookServer, no port collisions on the server REST
	//          + metrics entrypoints (R6 mitigation).
	it.todo('two concurrent stacks expose distinct DeepbookServer hosts');
});
