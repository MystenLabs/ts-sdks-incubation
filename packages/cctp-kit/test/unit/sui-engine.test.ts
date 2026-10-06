// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it, vi } from 'vitest';
import { SUI_MAINNET } from '../../src/chains/sui.js';
import {
	buildSuiBurnTransaction,
	buildSuiReceiveTransaction,
	suiIsNonceUsed,
} from '../../src/engine/sui.js';
import { toBytes32 } from '../../src/utils/bytes.js';
import { getChainRegistry } from '../../src/chains/index.js';

const base = getChainRegistry('mainnet').find((c) => c.key === 'base')!;

function moveCalls(tx: ReturnType<typeof buildSuiBurnTransaction>) {
	return tx
		.getData()
		.commands.filter((c) => c.$kind === 'MoveCall')
		.map((c) => {
			const call = c.MoveCall!;
			return `${call.package}::${call.module}::${call.function}`;
		});
}

describe('Sui CCTP v2 PTB builders', () => {
	it('builds the 3-call burn PTB in order', () => {
		const tx = buildSuiBurnTransaction(SUI_MAINNET, {
			sender: '0x1',
			amount: 1_000_000n,
			destinationDomain: base.domain,
			mintRecipient: toBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base),
			maxFee: 0n,
			minFinalityThreshold: 2000,
		});
		const { packages } = SUI_MAINNET;
		expect(moveCalls(tx)).toEqual([
			`${packages.tokenMessengerMinterV2}::deposit_for_burn::deposit_for_burn`,
			`${packages.stablecoinHandler}::handler::burn`,
			`${packages.tokenMessengerMinterV2}::deposit_for_burn::complete_burn`,
		]);
		const complete = tx.getData().commands.at(-1)!.MoveCall!;
		expect(complete.typeArguments).toEqual([
			SUI_MAINNET.usdcCoinType,
			`${packages.stablecoinHandler}::handler::Auth`,
		]);
		expect(tx.getData().sender).toBe(
			'0x0000000000000000000000000000000000000000000000000000000000000001',
		);
	});

	it('builds the 4-call receive PTB in order', () => {
		const tx = buildSuiReceiveTransaction(SUI_MAINNET, new Uint8Array([1, 2]), new Uint8Array([3]));
		const { packages } = SUI_MAINNET;
		expect(moveCalls(tx)).toEqual([
			`${packages.messageTransmitterV2}::receive_message::receive_message`,
			`${packages.tokenMessengerMinterV2}::handle_receive_message::prepare_mint`,
			`${packages.stablecoinHandler}::handler::mint`,
			`${packages.tokenMessengerMinterV2}::handle_receive_message::complete_mint`,
		]);
	});
});

describe('the "already claimed" lookup on Sui', () => {
	it("simulates the transmitter's nonce view and reads the answer", async () => {
		const nonce = new Uint8Array(32).fill(0xab);
		const simulateTransaction = vi.fn(async (_input: { transaction: Transaction }) => ({
			commandResults: [{ returnValues: [{ bcs: new Uint8Array([1]) }] }],
		}));
		const client = { core: { simulateTransaction } } as unknown as ClientWithCoreApi;
		expect(await suiIsNonceUsed(client, SUI_MAINNET, nonce)).toBe(true);
		const tx = simulateTransaction.mock.calls[0]![0].transaction;
		expect(moveCalls(tx)).toEqual([
			`${SUI_MAINNET.packages.messageTransmitterV2}::state::is_nonce_used`,
		]);
		// A simulation needs a sender even though the view does not care who asks.
		expect(tx.getData().sender).toMatch(/^0x0+$/);

		simulateTransaction.mockResolvedValueOnce({
			commandResults: [{ returnValues: [{ bcs: new Uint8Array([0]) }] }],
		});
		expect(await suiIsNonceUsed(client, SUI_MAINNET, nonce)).toBe(false);
	});

	it('does not guess when the simulation returns nothing', async () => {
		const client = {
			core: { simulateTransaction: vi.fn(async () => ({})) },
		} as unknown as ClientWithCoreApi;
		await expect(suiIsNonceUsed(client, SUI_MAINNET, new Uint8Array(32))).rejects.toThrow(
			/returned nothing/,
		);
	});
});
