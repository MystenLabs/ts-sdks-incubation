// Unit tests for the canonical dapp-kit slot contract.

import { describe, expect, it } from '@effect/vitest';

import {
	DAPP_KIT_SLOT_KEY,
	type DAppKitSlot,
} from '../../../src/build-integrations/runtime/dapp-kit-slot.ts';

describe('dapp-kit slot (canonical)', () => {
	it('uses the architected slot key', () => {
		expect(DAPP_KIT_SLOT_KEY).toBe('__devstackDAppKit__');
	});

	it('keeps the slot as a raw app-owned bridge, not a runtime writer helper', () => {
		const selectAccount = () => {};
		(globalThis as { __devstackDAppKit__?: DAppKitSlot }).__devstackDAppKit__ = {
			selectAccount,
		};
		expect(globalThis.__devstackDAppKit__?.selectAccount).toBe(selectAccount);
		delete (globalThis as { __devstackDAppKit__?: DAppKitSlot }).__devstackDAppKit__;
	});
});
