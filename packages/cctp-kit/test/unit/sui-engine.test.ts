// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { SUI_MAINNET } from '../../src/chains/sui.js';
import { buildSuiBurnTransaction, buildSuiReceiveTransaction } from '../../src/engine/sui.js';
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
