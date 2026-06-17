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

		it('HARD-CLAMPS devWallet OFF on mainnet even with an explicit opt-in', () => {
			// `{ mainnet: { devWallet: true } }` MUST NOT mount the test-only dev
			// wallet on real mainnet — it would flush the secret generated-extras
			// tree and inject a signer into a production build.
			expect(resolveNetworkOptions('mainnet', { mainnet: { devWallet: true } })).toEqual({
				devWallet: false,
				faucet: false,
				autoApproveSigning: false,
			});
		});

		it('ignores overrides keyed to a different network', () => {
			expect(resolveNetworkOptions('localnet', { mainnet: { devWallet: false } })).toEqual(
				defaultNetworkOptions('localnet'),
			);
		});

		it('falls back to the policy for a null override value', () => {
			expect(resolveNetworkOptions('localnet', { localnet: null as any })).toEqual(
				defaultNetworkOptions('localnet'),
			);
		});

		it('falls back to the policy for a non-object override value', () => {
			expect(resolveNetworkOptions('localnet', { localnet: 'yes' as any })).toEqual(
				defaultNetworkOptions('localnet'),
			);
		});

		it('falls back to the policy default for a non-boolean field', () => {
			// `devWallet: 'yes'` is not a boolean, so `asBool` discards it and
			// the field keeps the policy default (true on localnet).
			expect(
				resolveNetworkOptions('localnet', { localnet: { devWallet: 'yes' as any } }).devWallet,
			).toBe(true);
		});
	});
});
