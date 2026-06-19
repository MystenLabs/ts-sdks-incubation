import { describe, expect, it } from 'vitest';

import {
	defaultNetworkOptions,
	resolveNetworkOptions,
} from '../../src/orchestrators/network-options.ts';

describe('network-scoped options', () => {
	describe('defaultNetworkOptions', () => {
		it('turns dev wallet + faucet ON for every non-mainnet network, signing OFF', () => {
			// `autoApproveSigning` defaults OFF even on dev networks so `pnpm dev`
			// shows the real connect + approve UX; tests opt in via env/override.
			for (const network of ['localnet', 'testnet', 'devnet']) {
				expect(defaultNetworkOptions(network)).toEqual({
					devWallet: true,
					faucet: true,
					autoApproveSigning: false,
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
				autoApproveSigning: false,
			});
		});

		it('lets an author opt back into auto-approve on a dev network', () => {
			// The default is OFF, so a fast-iteration author can re-enable
			// auto-signing for localnet without the env var.
			expect(resolveNetworkOptions('localnet', { localnet: { autoApproveSigning: true } })).toEqual(
				{
					devWallet: true,
					faucet: true,
					autoApproveSigning: true,
				},
			);
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

		it('HARD-CLAMPS faucet + autoApproveSigning OFF on mainnet even with explicit opt-ins', () => {
			// Mirrors the devWallet clamp: no dev convenience may be silently
			// enabled on a real-funds mainnet. An explicit
			// `{ mainnet: { faucet: true, autoApproveSigning: true } }` MUST NOT
			// expose a funding faucet or auto-approve a real-funds signature.
			expect(
				resolveNetworkOptions('mainnet', {
					mainnet: { faucet: true, autoApproveSigning: true },
				}),
			).toEqual({
				devWallet: false,
				faucet: false,
				autoApproveSigning: false,
			});
		});

		it('honors faucet + autoApproveSigning overrides on a non-mainnet network', () => {
			// Off-by-override on a dev network: the clamp is mainnet-only, so a
			// non-mainnet network can opt each convenience out individually.
			expect(
				resolveNetworkOptions('testnet', {
					testnet: { faucet: false, autoApproveSigning: false },
				}),
			).toEqual({
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
