// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { WalletController } from '../src/ui/wallet-controller.js';
import { DevWallet } from '../src/wallet/dev-wallet.js';
import { createDefaultConfig } from './test-utils.js';

function setup() {
	const host = { addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn() };
	const ctrl = new WalletController(host as never);
	const wallet = new DevWallet(
		createDefaultConfig({
			networks: { devnet: 'https://d.example', testnet: 'https://t.example' },
			activeNetwork: 'devnet',
		}),
	);
	ctrl.wallet = wallet;
	ctrl.hostConnected();
	host.requestUpdate.mockClear();
	return { host, wallet };
}

describe('WalletController', () => {
	it('re-renders the host when the active network changes', () => {
		const { host, wallet } = setup();
		wallet.setActiveNetwork('testnet');
		expect(host.requestUpdate).toHaveBeenCalled();
	});

	it('re-renders the host when a network is added', () => {
		const { host, wallet } = setup();
		wallet.addNetwork('localnet', 'http://127.0.0.1:9000');
		expect(host.requestUpdate).toHaveBeenCalled();
	});
});
