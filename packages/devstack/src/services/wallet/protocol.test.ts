// Coherence guard: the wallet-app HTTP path contract lives in two
// places — `services/wallet/protocol.ts` (this package, the server
// side) and `packages/dev-wallet/src/adapters/devstack-paths.ts` (the
// browser-side adapter). They can't be folded into one module because
// devstack already (peer-)depends on dev-wallet, and the reverse edge
// would close a workspace cycle. This test imports both and asserts
// byte-for-byte equality so the two copies stay in lock-step.

import { describe, expect, it } from 'vitest';
import { DEVSTACK_WALLET_HTTP_PATH } from '@mysten-incubation/dev-wallet/adapters';
import { WalletHttpPath } from './protocol.js';

describe('WalletHttpPath ↔ DEVSTACK_WALLET_HTTP_PATH', () => {
	it('exposes the same set of keys', () => {
		expect(Object.keys(WalletHttpPath).sort()).toEqual(
			Object.keys(DEVSTACK_WALLET_HTTP_PATH).sort(),
		);
	});

	it('maps every key to an identical string', () => {
		// Iterate the union of keys so missing keys on either side surface
		// as `undefined !== '/api/...'` rather than a silent skip.
		const keys = new Set<string>([
			...Object.keys(WalletHttpPath),
			...Object.keys(DEVSTACK_WALLET_HTTP_PATH),
		]);
		for (const key of keys) {
			expect((WalletHttpPath as Record<string, string>)[key]).toBe(
				(DEVSTACK_WALLET_HTTP_PATH as Record<string, string>)[key],
			);
		}
	});
});
