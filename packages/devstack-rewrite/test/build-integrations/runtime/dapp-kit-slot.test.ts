// Unit tests for the canonical dapp-kit slot contract.

import { describe, expect, it } from '@effect/vitest';

import {
	clearDAppKitSlot,
	DAPP_KIT_SLOT_KEY,
	readDAppKitSlot,
	writeDAppKitSlot,
} from '../../../src/build-integrations/runtime/index.ts';

describe('dapp-kit slot (canonical)', () => {
	it('uses the architected slot key', () => {
		expect(DAPP_KIT_SLOT_KEY).toBe('__devstackDAppKit__');
	});

	it('reads `undefined` when the slot is empty', () => {
		clearDAppKitSlot();
		expect(readDAppKitSlot()).toBeUndefined();
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

	it('clearDAppKitSlot removes the slot', () => {
		writeDAppKitSlot({
			slotVersion: 1,
			identity: { app: 'a', stack: 'b', chain: 'c' },
			endpoints: {},
			flags: {},
		});
		clearDAppKitSlot();
		expect(readDAppKitSlot()).toBeUndefined();
	});
});
