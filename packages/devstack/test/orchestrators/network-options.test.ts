import { describe, expect, it } from 'vitest';

import {
	defaultNetworkOptions,
	resolveNetworkOptions,
} from '../../src/orchestrators/network-options.ts';

describe('network-scoped options', () => {
	describe('defaultNetworkOptions', () => {
		it('turns dev conveniences ON for every non-mainnet network', () => {
			for (const network of ['localnet', 'testnet', 'devnet']) {
				expect(defaultNetworkOptions(network)).toEqual({
					devWallet: true,
					faucet: true,
					autoApproveSigning: true,
				});
			}
		});

		it('turns dev conveniences OFF for live mainnet', () => {
			expect(defaultNetworkOptions('mainnet')).toEqual({
				devWallet: false,
				faucet: false,
				autoApproveSigning: false,
			});
		});

		it('keeps fork networks ON — a fork is a local dev stack', () => {
			for (const network of ['mainnet-fork', 'testnet-fork', 'devnet-fork']) {
				expect(defaultNetworkOptions(network).devWallet).toBe(true);
			}
		});
	});

	describe('resolveNetworkOptions', () => {
		it('returns the default policy when no overrides are given', () => {
			expect(resolveNetworkOptions('localnet')).toEqual(defaultNetworkOptions('localnet'));
			expect(resolveNetworkOptions('mainnet')).toEqual(defaultNetworkOptions('mainnet'));
		});

		it('merges author overrides field-by-field on top of the policy', () => {
			// Disable just the wallet on localnet; faucet/signing keep the default.
			expect(resolveNetworkOptions('localnet', { localnet: { devWallet: false } })).toEqual({
				devWallet: false,
				faucet: true,
				autoApproveSigning: true,
			});
		});

		it('lets an override OPT IN dev conveniences on mainnet', () => {
			expect(resolveNetworkOptions('mainnet', { mainnet: { devWallet: true } })).toEqual({
				devWallet: true,
				faucet: false,
				autoApproveSigning: false,
			});
		});

		it('ignores overrides keyed to a different network', () => {
			expect(resolveNetworkOptions('localnet', { mainnet: { devWallet: false } })).toEqual(
				defaultNetworkOptions('localnet'),
			);
		});
	});
});
