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

	it('restores faucet URLs, including ones added with a custom network', () => {
		const first = new DevWallet({ ...config(), faucets: { devnet: 'https://faucet.d' } });
		first.addNetwork('mynet', 'http://127.0.0.1:9000', 'http://127.0.0.1:9123');

		const second = new DevWallet(config());
		expect(second.getFaucet('devnet')).toBe('https://faucet.d');
		expect(second.getFaucet('mynet')).toBe('http://127.0.0.1:9123');
	});

	it('addNetwork sets a faucet with a URL, clears it with null, and keeps it when omitted', () => {
		const wallet = new DevWallet(config());
		wallet.addNetwork('mynet', 'http://a', 'http://faucet');
		wallet.addNetwork('mynet', 'http://b');
		expect(wallet.getFaucet('mynet')).toBe('http://faucet');
		wallet.addNetwork('mynet', 'http://b', null);
		expect(wallet.getFaucet('mynet')).toBeNull();
		expect(() => wallet.addNetwork('mynet', 'http://b', 'ftp://x')).toThrow('Invalid URL');
	});

	it('applies config faucets that previously persisted state predates', () => {
		localStorage.setItem(
			STATE_STORAGE_KEY,
			JSON.stringify({ version: 1, networks: { devnet: 'https://d' }, faucets: {} }),
		);
		const wallet = new DevWallet({ ...config(), faucets: { devnet: 'https://faucet.d' } });
		expect(wallet.getFaucet('devnet')).toBe('https://faucet.d');
	});

	it('keeps a removed config faucet removed across reloads', () => {
		const withFaucet = () => ({ ...config(), faucets: { devnet: 'https://faucet.d' } });
		new DevWallet(withFaucet()).addNetwork('devnet', 'https://d', null);
		expect(new DevWallet(withFaucet()).getFaucet('devnet')).toBeNull();
	});

	it('names the network in URL errors', () => {
		const wallet = new DevWallet(config());
		expect(() => wallet.addNetwork('mynet', 'nope')).toThrow('Invalid URL for network "mynet"');
		expect(() => wallet.addNetwork('mynet', 'http://a', 'nope')).toThrow(
			'Invalid URL for the faucet of network "mynet"',
		);
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
		['non-string faucet', JSON.stringify({ version: 1, networks: {}, faucets: { devnet: 1 } })],
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
