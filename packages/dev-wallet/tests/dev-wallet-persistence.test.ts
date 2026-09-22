// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevWallet, STATE_STORAGE_KEY } from '../src/wallet/dev-wallet.js';
import { createDefaultConfig } from './test-utils.js';

const config = () =>
	createDefaultConfig({
		networks: { devnet: 'https://fullnode.devnet.sui.io:443', testnet: 'https://t.example' },
		activeNetwork: 'devnet',
		persistState: true,
	});

describe('DevWallet persisted state', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('pins the storage key', () => {
		expect(STATE_STORAGE_KEY).toBe('dev-wallet:state:v1');
	});

	it('restores custom networks, the active network, and the active account', () => {
		const first = new DevWallet(config());
		first.addNetwork('localnet', 'http://127.0.0.1:9000');
		first.setActiveNetwork('localnet');
		first.setActiveAccount('0xabc');

		const second = new DevWallet(config());
		expect(second.networkUrls.localnet).toBe('http://127.0.0.1:9000');
		expect(second.activeNetwork).toBe('localnet');
		expect(second.activeAccount).toBe('0xabc');
	});

	it('keeps removed networks removed', () => {
		new DevWallet(config()).removeNetwork('testnet');
		expect(new DevWallet(config()).availableNetworks).toEqual(['devnet']);
	});

	it('falls back to config when the persisted active network no longer exists', () => {
		localStorage.setItem(
			STATE_STORAGE_KEY,
			JSON.stringify({ version: 1, networks: { devnet: 'https://d' }, activeNetwork: 'gone' }),
		);
		expect(new DevWallet(config()).activeNetwork).toBe('devnet');
	});

	it.each([
		['invalid JSON', '{'],
		['unknown version', JSON.stringify({ version: 2, networks: {} })],
		['non-string URL', JSON.stringify({ version: 1, networks: { devnet: 42 } })],
	])('ignores %s with a warning and uses config', (_label, raw) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem(STATE_STORAGE_KEY, raw);

		const wallet = new DevWallet(config());

		expect(wallet.availableNetworks).toEqual(['devnet', 'testnet']);
		expect(wallet.activeNetwork).toBe('devnet');
		expect(warn).toHaveBeenCalled();
	});

	it('does not touch storage when persistState is off', () => {
		new DevWallet({ ...config(), persistState: false }).setActiveNetwork('testnet');
		expect(localStorage.getItem(STATE_STORAGE_KEY)).toBeNull();
	});
});
