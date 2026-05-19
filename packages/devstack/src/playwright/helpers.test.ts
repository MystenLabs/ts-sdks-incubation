// Playwright `helpers.ts` exposes two functions: connectAs and
// selectAccount. Both interact with a real Playwright `Page` / `Locator`
// (locator queries, in-browser `evaluate`). A useful end-to-end test
// requires a real headless browser, which is what the examples' e2e
// suites cover.
//
// What this file pins:
//   - Module exports — guards against accidental renames during refactors.
//   - The selectors `connectAs` queries — if a refactor of dapp-kit ever
//     renames `mysten-dapp-kit-connect-button` or the `Dev Wallet` text,
//     this test fails fast pointing at the helper as the broken
//     dependency. The selectors live in helpers.ts; we read the file's
//     source to assert their presence.
//
// What this file deliberately does NOT cover (untestable without a
// browser):
//   - `connectAs` happy-path (clicks + waits + `evaluate`).
//   - `selectAccount` happy-path (filter().getAttribute()).
// These are exercised by the example apps' playwright e2e suites that
// run against a live dev wallet.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import * as helpers from './helpers.js';

const helpersSource = readFileSync(
	join(fileURLToPath(new URL('./', import.meta.url)), 'helpers.ts'),
	'utf-8',
);

describe('playwright/helpers — public surface', () => {
	it('exposes connectAs and selectAccount', () => {
		expect(typeof helpers.connectAs).toBe('function');
		expect(typeof helpers.selectAccount).toBe('function');
	});

	it('connectAs accepts (page, label) — arity 2', () => {
		// Arity is the user contract — connectAs(page, 'alice'). A bug
		// that flips to a positional options object would silently
		// drop the second argument; pin it here.
		expect(helpers.connectAs.length).toBe(2);
	});

	it('selectAccount accepts (select, name) — arity 2', () => {
		expect(helpers.selectAccount.length).toBe(2);
	});
});

describe('playwright/helpers — selector contracts', () => {
	// The helpers query dapp-kit's web-components by custom-element name.
	// Any rename upstream silently breaks every consumer's e2e suite —
	// these source-level assertions surface the rename at unit-test time.

	it('connectAs queries mysten-dapp-kit-connect-button + connect-modal', () => {
		expect(helpersSource).toContain("'mysten-dapp-kit-connect-button'");
		expect(helpersSource).toContain("'mysten-dapp-kit-connect-modal'");
	});

	it("connectAs filters the dev wallet by the literal text 'Dev Wallet'", () => {
		// The wallet's `name` field is registered as `'Dev Wallet'` by the
		// devstack dapp-kit emitter; the selector matches it exactly. If
		// the emitter ever renames the wallet, this test fails alongside
		// the wallet-config side of the rename.
		expect(helpersSource).toContain("'Dev Wallet'");
	});

	it('connectAs reads kit from globalThis.__devstackDAppKit__', () => {
		// This global is the wire between the user's dapp-kit.ts and
		// devstack's playwright helper. A rename without updating the
		// helpers + the example-app's dapp-kit.ts in lockstep would
		// produce a confusing "kit is undefined" runtime error.
		expect(helpersSource).toContain('__devstackDAppKit__');
	});
});
