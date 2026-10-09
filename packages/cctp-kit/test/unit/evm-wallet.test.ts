// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Config } from '@wagmi/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import type { EvmChainDefinition } from '../../src/chains/types.js';
import { WalletNetworkError } from '../../src/utils/errors.js';
import { createEvmWalletFromWagmiConfig } from '../../src/wallets/wagmi.js';

const wagmi = vi.hoisted(() => ({
	getAccount: vi.fn(),
	getWalletClient: vi.fn(),
	switchChain: vi.fn(),
	watchAccount: vi.fn(),
	disconnect: vi.fn(),
}));
vi.mock('@wagmi/core', () => wagmi);

const base = getChainRegistry('mainnet').find((c) => c.key === 'base') as EvmChainDefinition;
const ETHEREUM = 1;
const client = { account: { address: '0x1111111111111111111111111111111111111111' } };

/** A connected wallet: the network wagmi remembers, and the one the wallet says it is on. */
function walletIs(on: { remembered: number; actual: () => number }) {
	wagmi.getAccount.mockImplementation(() => ({
		chainId: on.remembered,
		connector: { getChainId: async () => on.actual() },
	}));
}

/** What wagmi throws when a wallet has no way to add or switch to a network. */
const cannotSwitch = () =>
	Object.assign(
		new Error('User rejected the request.\n\nDetails: Method not found\nVersion: viem@2.57.3'),
		{ name: 'UserRejectedRequestError', code: 4001 },
	);

describe('getting an EVM wallet onto the network a transfer needs', () => {
	const adapter = createEvmWalletFromWagmiConfig({} as Config);
	beforeEach(() => {
		for (const mock of Object.values(wagmi)) mock.mockReset();
		wagmi.getWalletClient.mockResolvedValue(client);
	});

	it('asks for nothing when the wallet is already there', async () => {
		walletIs({ remembered: base.chainId, actual: () => base.chainId });
		expect(await adapter.getWalletClient(base)).toBe(client);
		expect(wagmi.switchChain).not.toHaveBeenCalled();
	});

	it('asks the wallet to switch when it is elsewhere', async () => {
		let actual = ETHEREUM;
		walletIs({ remembered: ETHEREUM, actual: () => actual });
		wagmi.switchChain.mockImplementation(async () => {
			actual = base.chainId;
		});
		expect(await adapter.getWalletClient(base)).toBe(client);
		expect(wagmi.switchChain).toHaveBeenCalledTimes(1);
		expect(wagmi.switchChain.mock.calls[0]![1]).toMatchObject({ chainId: base.chainId });
	});

	it('says to switch by hand when the wallet cannot be told to', async () => {
		// A wallet in a phone's in-app browser. wagmi words this as the user rejecting a
		// request, which sent someone looking for a prompt they never saw.
		walletIs({ remembered: ETHEREUM, actual: () => ETHEREUM });
		const refusal = cannotSwitch();
		wagmi.switchChain.mockRejectedValue(refusal);
		const failure = await adapter.getWalletClient(base).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(WalletNetworkError);
		expect((failure as Error).message).toBe(
			'Your wallet is on another network. Switch it to Base in the wallet, then try again.',
		);
		expect((failure as Error).cause).toBe(refusal);
		expect(wagmi.getWalletClient).not.toHaveBeenCalled();
	});

	it('goes ahead once the wallet was switched by hand, even if it never said so', async () => {
		// wagmi still remembers Ethereum, because the wallet gave no notice of the change.
		walletIs({ remembered: ETHEREUM, actual: () => base.chainId });
		expect(await adapter.getWalletClient(base)).toBe(client);
		expect(wagmi.switchChain).not.toHaveBeenCalled();
	});

	it('goes ahead when the wallet switched and answered with an error all the same', async () => {
		let actual = ETHEREUM;
		walletIs({ remembered: ETHEREUM, actual: () => actual });
		wagmi.switchChain.mockImplementation(async () => {
			actual = base.chainId;
			throw cannotSwitch();
		});
		expect(await adapter.getWalletClient(base)).toBe(client);
	});

	it('falls back on what wagmi remembers when the wallet cannot be asked', async () => {
		wagmi.getAccount.mockImplementation(() => ({
			chainId: base.chainId,
			connector: {
				getChainId: async () => {
					throw new Error('provider not ready');
				},
			},
		}));
		expect(await adapter.getWalletClient(base)).toBe(client);
		expect(wagmi.switchChain).not.toHaveBeenCalled();
	});
});
