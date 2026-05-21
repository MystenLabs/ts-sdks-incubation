// Unit tests for the dapp-kit slot — re-exported by the vite barrel
// from the canonical `runtime/` substrate. The vite barrel re-export
// is asserted here (the slot's authoritative tests live in
// test/build-integrations/runtime/).

import { describe, expect, it } from '@effect/vitest';

import {
	clearDAppKitSlot,
	DAPP_KIT_SLOT_KEY,
	readDAppKitSlot,
	writeDAppKitSlot,
} from '../../../src/build-integrations/vite/index.ts';

describe('vite barrel re-exports the canonical dapp-kit slot', () => {
	it('uses the architected slot key', () => {
		expect(DAPP_KIT_SLOT_KEY).toBe('__devstackDAppKit__');
	});

	it('round-trips a slot value', () => {
		writeDAppKitSlot({
			slotVersion: 1,
			identity: { app: 'wallet', stack: 'main', chain: 'sui:local' },
			endpoints: { 'sui-rpc': { url: 'http://x/' } },
			flags: { devWalletLabel: 'Dev Wallet' },
		});
		const read = readDAppKitSlot();
		expect(read?.identity.app).toBe('wallet');
		expect(read?.endpoints['sui-rpc']?.url).toBe('http://x/');
		clearDAppKitSlot();
	});
});
