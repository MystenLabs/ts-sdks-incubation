// Playwright stack-context slot — typed `globalThis` contract.
//
// Pins backlog #31: the `globalThis.__devstackPlaywrightStackContext__`
// slot is typed via a `declare global` block alongside its key + shape,
// matching the `dapp-kit-slot` pattern. Eliminates the
// `as unknown as GlobalSlot` cast in `playwright/global-setup.ts`.

import { describe, expect, it, afterEach } from 'vitest';

import {
	PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY,
	type PlaywrightStackFixture,
} from '../../../src/build-integrations/runtime/playwright-stack-context-slot.ts';

describe('PlaywrightStackContextSlot — typed global slot', () => {
	afterEach(() => {
		// Don't leak fixture state across tests.
		globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = undefined;
	});

	it('exposes the slot key as a const literal', () => {
		expect(PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY).toBe('__devstackPlaywrightStackContext__');
	});

	it('the typed `declare global` block lets callers read/write without casts', () => {
		const fixture: PlaywrightStackFixture = {
			endpoints: { dev: 'http://main.app.localhost:5175' },
			walletEndpoint: null,
			manifestPath: '/tmp/manifest.json',
			stack: 'main',
			app: 'app',
		};
		// This assignment is type-checked through the `declare global`
		// declaration — no `as unknown as ...` escape needed.
		globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = fixture;
		expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]).toBe(fixture);
	});

	it('reading the slot when unset yields undefined (matches dapp-kit-slot semantics)', () => {
		expect(globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY]).toBeUndefined();
	});
});
