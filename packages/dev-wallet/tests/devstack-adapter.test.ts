// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// `createDevstackAdapterFromManifest` threads an optional `networks` set into
// the adapter so accounts built from a manifest advertise fork/custom chains as
// `sui:<name>` — matching the constructor path the devstack-injected dev wallet
// uses. Without it, the manifest helper would silently advertise the standard
// Sui chains only, under-advertising fork/custom networks.

import { toBase64 } from '@mysten/sui/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDevstackAdapterFromManifest } from '../src/adapters/devstack-adapter.js';

const SERVER_ORIGIN = 'http://localhost:9420';
const manifest = { app: { wallet: { url: SERVER_ORIGIN } } };

// One ed25519 account the mocked accounts endpoint returns. A 32-byte key is
// the only requirement for Ed25519PublicKey; the bytes themselves are arbitrary.
const ACCOUNT = {
	name: 'a0',
	address: '0x0000000000000000000000000000000000000000000000000000000000000001',
	scheme: 'ed25519',
	publicKey: toBase64(new Uint8Array(32)),
};

describe('createDevstackAdapterFromManifest', () => {
	beforeEach(() => {
		// The adapter fetches accounts over HTTP on initialize(); return one
		// account so the built per-account chains are observable.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ accounts: [ACCOUNT] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	});

	afterEach(() => vi.restoreAllMocks());

	it('returns null when the manifest carries no wallet entry', () => {
		expect(createDevstackAdapterFromManifest({})).toBeNull();
		expect(createDevstackAdapterFromManifest({ app: {} })).toBeNull();
	});

	it('advertises configured networks (incl. fork/custom) on every account when networks are passed', async () => {
		const adapter = createDevstackAdapterFromManifest(manifest, {
			networks: ['testnet-fork', 'custom'],
		});
		expect(adapter).not.toBeNull();
		await adapter!.initialize();

		const [account] = adapter!.getAccounts();
		expect(account).toBeDefined();
		// The configured non-standard names are advertised...
		expect(account!.walletAccount.chains).toContain('sui:testnet-fork');
		expect(account!.walletAccount.chains).toContain('sui:custom');
		// ...unioned with the standard Sui chains.
		expect(account!.walletAccount.chains).toContain('sui:localnet');
		expect(account!.walletAccount.chains).toContain('sui:mainnet');
	});

	it('advertises the standard Sui chains only when no networks are passed', async () => {
		const adapter = createDevstackAdapterFromManifest(manifest);
		await adapter!.initialize();

		const [account] = adapter!.getAccounts();
		expect(account!.walletAccount.chains).toContain('sui:localnet');
		expect(account!.walletAccount.chains).not.toContain('sui:testnet-fork');
	});
});
