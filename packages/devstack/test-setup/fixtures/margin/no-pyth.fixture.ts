// P4.T5 fixture — a deliberately-broken margin config that OMITS the
// `pyth` option. The `deepbookMargin` factory's option type declares
// `pyth: LayeredTag<...>` as REQUIRED (Phase 4 D5 — typecheck-enforced
// Pyth+Margin coupling). `pnpm tsc --noEmit` against this file MUST
// exit non-zero; the test harness runs the typecheck and asserts the
// failure.
//
// This file is **isolated** from the package's normal compile path —
// the test invokes tsc against this file directly via a generated
// tsconfig (see `margin-typecheck.test.ts`) so the broken config
// doesn't break the rest of the package.

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { deepbookMargin, USDC_MARGIN_DEFAULTS } from '../../../src/services/deepbook/index.js';

const stubTag = (): any => ({}) as any;

// MISSING `pyth` — this MUST be a typecheck error. The whole point of
// P4.T5 is to lock in the type-level enforcement that prevents silent
// misconfiguration. Do NOT cast the argument — the cast would suppress
// the very error the test is asserting.
const broken = deepbookMargin({
	signer: stubTag(),
	margin: { movePackagePath: '/tmp/m' },
	liquidation: { movePackagePath: '/tmp/l' },
	// pyth: stubTag(), <-- intentionally missing
	deepbook: stubTag(),
	assets: [{ ...USDC_MARGIN_DEFAULTS, coinType: '0xabc::usdc::USDC' }],
	pools: [],
});

export {};
