// Cross-module pin: the wallet's fallback port-scan window is the
// broker's `DEFAULT_PORT_WINDOW`, not a divergent local literal.
//
// Why this test exists (review fix — nit: "DEFAULT_PORT_WINDOW
// duplicated as a wallet literal and pinned by no test"):
//
//   The dev-wallet browser adapter's auto-connect heuristic scans a
//   fixed port range (39200..40199 inclusive — the half-open
//   `[start, start + size)` the broker scans). The wallet plugin pins
//   that range by passing a `windowHint` to `portBroker.allocate`. The
//   value MUST stay equal to the broker's exported `DEFAULT_PORT_WINDOW`
//   so a retune of the broker default can't silently leave the wallet
//   (and its UX comment + the external adapter) scanning a stale range.
//
//   The repo rule "shared cross-module constants are pinned by a test"
//   was previously unmet here: the wallet hardcoded `{ start: 39200,
//   size: 1000 }` as a literal with no test tying it to the broker.
//
// Falsifiability: the production fix makes the pin structural — the
// wallet now imports `DEFAULT_PORT_WINDOW` and forwards it verbatim. The
// first assertion below would FAIL if someone retuned the broker default
// away from the UX-pinned `{ start: 39200, size: 1000 }` (forcing a
// conscious decision about the dev-wallet adapter range). The second
// asserts the half-open window's inclusive upper bound is 40199 — the
// exact value the wallet's comment and the adapter heuristic depend on;
// it would FAIL if `size` drifted to 1001 (which would extend the range
// to 40200 inclusive) without the comment/adapter being updated.

import { describe, expect, it } from '@effect/vitest';

import { DEFAULT_PORT_WINDOW } from '../../../src/substrate/runtime/port-broker/index.ts';

describe('wallet port-window cross-module pin', () => {
	it('broker DEFAULT_PORT_WINDOW equals the dev-wallet UX-pinned range', () => {
		// The dev-wallet adapter's auto-connect heuristic is wired to this
		// exact start/size. Changing the broker default is a deliberate,
		// adapter-affecting change — this assertion makes it loud.
		expect(DEFAULT_PORT_WINDOW).toStrictEqual({ start: 39200, size: 1000 });
	});

	it('the half-open window covers 39200..40199 inclusive', () => {
		// Broker scan window is `[start, start + size)`; the inclusive
		// upper bound is therefore `start + size - 1`. The wallet's source
		// comment claims 39200..40199 — pin that arithmetic so the comment
		// can't silently drift if `size` is retuned.
		expect(DEFAULT_PORT_WINDOW.start).toBe(39200);
		expect(DEFAULT_PORT_WINDOW.start + DEFAULT_PORT_WINDOW.size - 1).toBe(40199);
	});
});
