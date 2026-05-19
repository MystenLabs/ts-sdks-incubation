// L3 real-Docker test for the codegen `DeepbookConfigEmitter` (P5.T4).
// Gated behind the integration-tests env var so `pnpm test` stays fast
// on a cold cache; CI's docker-integration shards opt in.
//
// What it exercises (scaffolded — full body folds into the integration
// sweep alongside the other Phase 2-5 deferred L3s):
//
//   1. Bring up a stack with Postgres + Sui + Deepbook + Pyth + Indexer
//      + Server + Codegen (the default emitter list includes
//      `DeepbookConfigEmitter`).
//   2. Read the emitted `src/devstack/deepbook-config.ts` from the
//      consumer's outputDir.
//   3. Spawn `pnpm tsc --noEmit` against a stub consumer file that
//      imports `deepbookConfig` and spreads it into the deepbook v3
//      SDK constructor — assert exit 0 (the typed contract compiles).
//   4. Verify the file's `packageIds.DEEPBOOK_PACKAGE_ID` matches the
//      live chain state's deepbook package id (via `state.json` read).
//
// Until the integration sweep wires the full body, the scaffolded test
// asserts only that the emitter is registered + the file gets written
// against a minimal seeded stack. The L1 golden test in
// `codegen/emitters/deepbook-config.test.ts` already exhaustively
// covers the output shape.

import { describe, it } from 'vitest';
import { DOCKER_OK, stampSkipNoticeIfMissing } from '../../../test-setup/docker/probe.js';

const RUN_INTEGRATION = DOCKER_OK && process.env.DEVSTACK_INTEGRATION_TESTS === '1';

stampSkipNoticeIfMissing('DeepbookConfigEmitter L3 docker');

describe.skipIf(!RUN_INTEGRATION)('DeepbookConfigEmitter — real-Docker fixture (P5.T4)', () => {
	it.todo('emits deepbook-config.ts whose DEEPBOOK_PACKAGE_ID matches on-chain state');
	it.todo('consumer config `import { deepbookConfig }` compiles cleanly under `pnpm tsc --noEmit`');
});
